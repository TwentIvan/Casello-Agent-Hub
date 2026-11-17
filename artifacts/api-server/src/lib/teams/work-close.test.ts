import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appsTable, db, pool, teamCodeTasksTable, teamEventsTable, teamInstancesTable, teamWorksTable, usersTable } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { githubConfig, resetGithubConfigForTests } from "../github/config";
import { getPlan, writePlanVersion } from "./plan";
import { WORK_MESSAGES } from "./works";
import { commitFiles, createBranch, createDraftPull, getCommitTree, type RepoRef } from "../code-writer/github-git";
import { watchCodeTasksOnce } from "../code-writer/watcher";
import { closeWorkIfDone } from "./works";
import { pendingActionsTable } from "@workspace/db";

// Chiusura del lavoro: un solo «Lavoro finito», branch di prova riscritto, voce «Porta in produzione» (PGlite + finto GitHub)

const REPO = "ivan/mister";
const ENV_KEYS = ["CASELLO_SECRET_KEY", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
const saved: Record<string, string | undefined> = {};
const T0 = new Date("2026-11-17T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
let gh: FakeGithub;
let r: RepoRef;
let instanceId: number;
let workId: number;
let workBranchName: string;
let codeId: number;
let prHead: string;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  gh = await startFakeGithub();
  Object.assign(process.env, {
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
    CASELLO_SECRET_KEY: "a".repeat(64),
  });
  resetGithubConfigForTests();
});

afterAll(async () => {
  await gh.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetGithubConfigForTests();
  await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
});

/** Commit sul branch del compito (creato dalla testa del lavoro) con i file dati, poi la PR in bozza verso il lavoro. */
async function taskPull(files: Record<string, string>): Promise<void> {
  const workHead = gh.git.get(REPO)!.refs.get(`heads/${workBranchName}`)!;
  const branch = `botcave/${instanceId}-t1`;
  const { sha } = await commitFiles(r, {
    branch,
    parentSha: workHead,
    baseTreeSha: await getCommitTree(r, workHead),
    changes: new Map(Object.entries(files)),
    message: "compito t1",
    createBranch: true,
  });
  const pull = await createDraftPull(r, { head: branch, base: workBranchName, title: "t1", body: "" });
  prHead = sha;
  const [code] = await db
    .insert(teamCodeTasksTable)
    .values({ instanceId, planTaskId: "t1", repo: REPO, branch, baseBranch: workBranchName, headSha: sha, prNumber: pull.number, prUrl: pull.url, prState: "open", ciState: "pending", lastCommitAt: T0, workId })
    .returning();
  codeId = code!.id;
}

const ciGreen = () => gh.checkRuns.set(prHead, [{ id: 1, name: "test", status: "completed", conclusion: "success", annotations: [] }]);
const events = async () => (await db.select().from(teamEventsTable).where(eq(teamEventsTable.instanceId, instanceId))).sort((a, b) => a.id - b.id);
const codeRow = async () => (await db.select().from(teamCodeTasksTable).where(eq(teamCodeTasksTable.id, codeId)))[0]!;
const workRow = async () => (await db.select().from(teamWorksTable).where(eq(teamWorksTable.id, workId)))[0]!;

beforeEach(async () => {
  clearInstallationTokenCache();
  gh.pulls.clear();
  gh.checkRuns.clear();
  gh.statuses.clear();
  gh.installations.clear();
  gh.repos.clear();
  gh.installationPermissions.clear();
  gh.addInstallation({ id: 7, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(7, { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", issues: "write", metadata: "read" });
  const mainSha = gh.seedRepo(REPO, "main", { "a.txt": "uno" });
  await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "capo@example.com", name: "Ivan" }).returning();
  const { githubInstallationsTable } = await import("@workspace/db");
  await db.insert(githubInstallationsTable).values({ userId: u!.id, installationId: 7, accountLogin: "ivan", accountType: "User", repositorySelection: "selected" });
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: "mister", baseUrl: "https://mister.example", sourceType: "github", sourceRepo: REPO, sourceInstallationId: 7 })
    .returning();
  const [inst] = await db
    .insert(teamInstancesTable)
    .values({ name: "Squadra", refAppId: app!.id, refType: "wi", refId: "1", refTitle: "WI 1", status: "active", roles: [{ key: "dev", name: "Dev", task: "", isLead: false, runsOn: "cloud", aiModelId: null, tools: [], skills: [], localSkills: [], code: "write" }] as never, createdBy: u!.id, activatedBy: u!.id })
    .returning();
  instanceId = inst!.id;
  await writePlanVersion(
    instanceId,
    { objective: "o", constraints: [], openPoints: [], manualActions: [], tasks: [{ id: "t1", title: "T", roleKey: "dev", instructions: "", status: "done", outcome: "ok" }] },
    "approved",
  );
  r = { cfg: githubConfig()!, installationId: 7, repo: REPO };
  workBranchName = `botcave/lavoro-${instanceId}-1`;
  await createBranch(r, workBranchName, mainSha);
  const [work] = await db
    .insert(teamWorksTable)
    .values({ instanceId, number: 1, repo: REPO, branch: workBranchName, baseBranch: "main", baseSha: mainSha, headSha: mainSha })
    .returning();
  workId = work!.id;
});


const setStaging = (stagingBranch: string | null, stagingUrl: string | null = "https://staging.mister.example") =>
  db.update(appsTable).set({ stagingBranch, stagingUrl });
const items = () => db.select().from(pendingActionsTable).where(eq(pendingActionsTable.kind, "release"));

describe("chiusura del lavoro", () => {
  it("ultimo compito unito: lavoro in prova, branch di prova riscritto, voce Porta in produzione", async () => {
    await setStaging("staging");
    await taskPull({ "b.txt": "due" });
    ciGreen();
    await watchCodeTasksOnce(at(60_000));
    await watchCodeTasksOnce(at(120_000));
    const work = await workRow();
    expect(work.status).toBe("awaiting_release");
    const workHead = gh.git.get(REPO)!.refs.get(`heads/${workBranchName}`)!;
    expect(gh.git.get(REPO)!.refs.get("heads/staging")).toBe(workHead);
    const ev = await events();
    expect(ev.filter((e) => e.type === "lavoro_finito")).toHaveLength(1);
    expect(ev.some((e) => e.type === "lavoro_in_prova" && (e.bulletin ?? "").includes("https://staging.mister.example"))).toBe(true);
    const queued = await items();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "pending", teamInstanceId: instanceId, summary: "Porta in produzione il lavoro 1 di Squadra" });
    expect(queued[0]!.argsPublic).toMatchObject({ workId, branch: workBranchName, stagingUrl: "https://staging.mister.example", postScripts: [] });
    expect(work.pendingActionId).toBe(queued[0]!.id);
    // Un altro giro non rifà nulla
    await watchCodeTasksOnce(at(180_000));
    expect(await items()).toHaveLength(1);
  });

  it("chiudi_lavoro due volte: un solo Lavoro finito, la seconda volta il messaggio fisso", async () => {
    await setStaging(null);
    await taskPull({ "b.txt": "due" });
    await db.update(teamCodeTasksTable).set({ prState: "merged" });
    const { LEAD_TOOLS, leadToolHandler } = await import("./lead-tools");
    const tool = LEAD_TOOLS.find((t) => t.name === "chiudi_lavoro")!;
    const handler = leadToolHandler({ instanceId, userId: (await db.select().from(usersTable))[0]!.id, teamName: "Squadra", roleKeys: ["dev"] });
    const first = await handler(tool, { bulletin: "Fatto" });
    expect(first.ok, first.content).toBe(true);
    const second = await handler(tool, { bulletin: "Fatto di nuovo" });
    expect(second).toEqual({ ok: false, content: WORK_MESSAGES.alreadyClosed });
    expect((await events()).filter((e) => e.type === "lavoro_finito")).toHaveLength(1);
    const queued = await items();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.argsPublic).toMatchObject({ stagingUrl: null, stagingNote: WORK_MESSAGES.noStaging });
    expect(gh.git.get(REPO)!.refs.has("heads/staging")).toBe(false);
  });

  it("lavoro senza PR unite: abbandonato con l'evento, nessuna voce", async () => {
    await closeWorkIfDone(instanceId);
    expect((await workRow()).status).toBe("abandoned");
    expect((await events()).some((e) => e.type === "bloccato" && e.bulletin === WORK_MESSAGES.nothingMerged)).toBe(true);
    expect(await items()).toHaveLength(0);
  });

  it("branch di prova uguale al base (riga cambiata a mano): nessuna scrittura forzata, voce con l'avviso", async () => {
    await setStaging("main");
    await taskPull({ "b.txt": "due" });
    await db.update(teamCodeTasksTable).set({ prState: "merged" });
    const mainBefore = gh.git.get(REPO)!.refs.get("heads/main");
    await closeWorkIfDone(instanceId);
    expect(gh.git.get(REPO)!.refs.get("heads/main")).toBe(mainBefore);
    expect((await items())[0]!.argsPublic).toMatchObject({ stagingNote: WORK_MESSAGES.noStaging });
  });
});

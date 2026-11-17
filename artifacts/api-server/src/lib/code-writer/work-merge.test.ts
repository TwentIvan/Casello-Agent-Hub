import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appsTable, db, pool, teamCodeTasksTable, teamEventsTable, teamInstancesTable, teamWorksTable, usersTable } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { githubConfig, resetGithubConfigForTests } from "../github/config";
import { getPlan, writePlanVersion } from "../teams/plan";
import { WORK_MESSAGES } from "../teams/works";
import { commitFiles, createBranch, createDraftPull, getCommitTree, type RepoRef } from "./github-git";
import { MERGE_MESSAGES, mergeTeamPull } from "./merge";
import { watchCodeTasksOnce } from "./watcher";

// Merge automatico delle PR dei compiti sul branch del lavoro con la CI verde, CI obbligatoria (PGlite + finto GitHub)

const REPO = "ivan/mister";
const ENV_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
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
    .values({ name: "Squadra", refAppId: app!.id, refType: "wi", refId: "1", refTitle: "WI 1", status: "active", roles: [], createdBy: u!.id, activatedBy: u!.id })
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

describe("merge automatico sul branch del lavoro", () => {
  it("CI verde: Botcave unisce con squash sul branch del lavoro, al giro dopo pr_closed", async () => {
    await taskPull({ "b.txt": "due" });
    ciGreen();
    await watchCodeTasksOnce(at(60_000));
    const pull = gh.pulls.get(REPO)![0]!;
    expect(pull).toMatchObject({ merged: true, mergeMethod: "squash" });
    expect(gh.filesAt(REPO, workBranchName)).toMatchObject({ "a.txt": "uno", "b.txt": "due" });
    expect(gh.filesAt(REPO, "main")).toEqual({ "a.txt": "uno" });
    await watchCodeTasksOnce(at(120_000));
    expect((await codeRow()).prState).toBe("merged");
    expect((await workRow()).headSha).toBe(gh.git.get(REPO)!.refs.get(`heads/${workBranchName}`));
  });

  it("PR con uno script -post: unita e il nome finisce nel lavoro", async () => {
    await taskPull({ "docs/migrations/2026-11-18-x-post.sql": "DROP TABLE vecchia;" });
    ciGreen();
    await watchCodeTasksOnce(at(60_000));
    expect(gh.pulls.get(REPO)![0]!.merged).toBe(true);
    expect((await workRow()).postScripts).toEqual(["docs/migrations/2026-11-18-x-post.sql"]);
  });

  it("PR che tocca i workflow: nessun merge, compito bloccato con il messaggio", async () => {
    await taskPull({ ".github/workflows/ci.yml": "on: push" });
    ciGreen();
    await watchCodeTasksOnce(at(60_000));
    expect(gh.pulls.get(REPO)![0]!.merged).toBe(false);
    const ev = await events();
    expect(ev.some((e) => e.type === "bloccato" && e.detail === MERGE_MESSAGES.workflows)).toBe(true);
    expect((await getPlan(instanceId)).tasks[0]).toMatchObject({ status: "blocked", outcome: MERGE_MESSAGES.workflows });
  });

  it("nessuna CI: compito bloccato con il messaggio della CI obbligatoria, nessun merge", async () => {
    await taskPull({ "b.txt": "due" });
    await watchCodeTasksOnce(at(11 * 60_000));
    expect(gh.pulls.get(REPO)![0]!.merged).toBe(false);
    expect((await getPlan(instanceId)).tasks[0]).toMatchObject({ status: "blocked", outcome: WORK_MESSAGES.noCi });
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "bloccato" });
  });

  it("unisci_pr su una PR del lavoro: rifiuto", async () => {
    await taskPull({ "b.txt": "due" });
    ciGreen();
    const res = await mergeTeamPull(instanceId, { compito: "t1" });
    expect(res).toEqual({ ok: false, content: WORK_MESSAGES.workPull });
  });
});

describe("freno dei fallimenti", () => {
  it("la CI mancante è un problema d'ambiente: non conta nei 3 fallimenti", async () => {
    const { isEnvironmentFailure } = await import("../teams/lead-tools");
    expect(isEnvironmentFailure(WORK_MESSAGES.noCi)).toBe(true);
  });
});

describe("I1: merge ritentato", () => {
  it("un merge non riuscito al primo giro (lavoro momentaneamente non aperto) si ritenta ai giri dopo", async () => {
    await taskPull({ "b.txt": "due" });
    ciGreen();
    await db.update(teamWorksTable).set({ status: "awaiting_release" }).where(eq(teamWorksTable.id, workId));
    await watchCodeTasksOnce(at(60_000));
    expect(gh.pulls.get(REPO)![0]!.merged).toBe(false);
    await db.update(teamWorksTable).set({ status: "open" }).where(eq(teamWorksTable.id, workId));
    await watchCodeTasksOnce(at(120_000));
    expect(gh.pulls.get(REPO)![0]!.merged).toBe(true);
  });

  it("un rifiuto si notifica una volta sola, anche se il merge si ritenta", async () => {
    await taskPull({ ".github/workflows/ci.yml": "on: push" });
    ciGreen();
    await watchCodeTasksOnce(at(60_000));
    await watchCodeTasksOnce(at(120_000));
    const ev = await events();
    expect(ev.filter((e) => e.type === "bloccato" && e.detail === MERGE_MESSAGES.workflows)).toHaveLength(1);
  });
});

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

// Decisione di «Porta in produzione»: PR del lavoro verso main, CI, commit di merge, conflitti, rifiuto, riavvio (PGlite + finto GitHub)

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



import { approveAction, failInterruptedActions, rejectAction } from "../actions/decide";
import { RELEASE_MESSAGES, watchReleasesOnce } from "./release";
import { teamTurnsTable } from "@workspace/db";

let userIdOf: number;

/** Lavoro con un compito unito e la voce «Porta in produzione» in coda; risponde il numero della voce. */
async function readyWork(): Promise<number> {
  userIdOf = (await db.select().from(usersTable))[0]!.id;
  await taskPull({ "b.txt": "due" });
  ciGreen();
  await watchCodeTasksOnce(at(60_000));
  await watchCodeTasksOnce(at(120_000));
  const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.kind, "release"));
  return item!.number;
}

const item = async () => (await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.kind, "release")))[0]!;
const releasePull = () => gh.pulls.get(REPO)!.find((p) => p.head === workBranchName)!;
const greenOn = (sha: string) => gh.checkRuns.set(sha, [{ id: 9, name: "test", status: "completed", conclusion: "success", annotations: [] }]);
const reasons = async () => (await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId))).flatMap((t) => t.reasons);

describe("Porta in produzione", () => {
  it("approvata: PR del lavoro verso main, CI verde, commit di merge, voce done e lavoro released", async () => {
    const n = await readyWork();
    const res = await approveAction(userIdOf, n);
    expect(res.ok, res.ok ? "" : res.message).toBe(true);
    expect((await item()).status).toBe("executing");
    expect((await workRow()).status).toBe("releasing");
    const pull = releasePull();
    expect(pull).toMatchObject({ base: "main", draft: false, state: "open" });
    greenOn(gh.git.get(REPO)!.refs.get(`heads/${workBranchName}`)!);
    await watchReleasesOnce(at(5 * 60_000));
    expect(releasePull()).toMatchObject({ merged: true, mergeMethod: "merge" });
    expect(gh.filesAt(REPO, "main")).toMatchObject({ "a.txt": "uno", "b.txt": "due" });
    expect(await item()).toMatchObject({ status: "done", result: RELEASE_MESSAGES.released(1) });
    expect((await workRow()).status).toBe("released");
  });

  it("main avanzato: si unisce main nel lavoro prima della PR", async () => {
    const n = await readyWork();
    const repo = gh.git.get(REPO)!;
    // Commit su main dopo l'apertura del lavoro (es. un'altra PR unita a mano)
    const mainHead = repo.refs.get("heads/main")!;
    const { sha } = await commitFiles(r, { branch: `botcave/${instanceId}-t9`, parentSha: mainHead, baseTreeSha: await getCommitTree(r, mainHead), changes: new Map([["c.txt", "tre"]]), message: "altro", createBranch: true });
    repo.refs.set("heads/main", sha);
    const res = await approveAction(userIdOf, n);
    expect(res.ok).toBe(true);
    expect(gh.filesAt(REPO, workBranchName)).toMatchObject({ "b.txt": "due", "c.txt": "tre" });
  });

  it("conflitto con main: voce failed, lavoro di nuovo aperto, turno del capo", async () => {
    const n = await readyWork();
    const repo = gh.git.get(REPO)!;
    const mainHead = repo.refs.get("heads/main")!;
    const { sha } = await commitFiles(r, { branch: `botcave/${instanceId}-t9`, parentSha: mainHead, baseTreeSha: await getCommitTree(r, mainHead), changes: new Map([["b.txt", "altro"]]), message: "altro", createBranch: true });
    repo.refs.set("heads/main", sha);
    gh.mergeConflicts.add(REPO);
    const res = await approveAction(userIdOf, n);
    expect(res.ok).toBe(true);
    expect(await item()).toMatchObject({ status: "failed", errorMessage: RELEASE_MESSAGES.conflict("main") });
    expect((await workRow()).status).toBe("open");
    expect(await reasons()).toContainEqual({ type: "release_failed", workId, message: RELEASE_MESSAGES.conflict("main") });
    gh.mergeConflicts.delete(REPO);
  });

  it("CI rossa sulla PR di rilascio: voce failed, lavoro aperto, turno", async () => {
    const n = await readyWork();
    await approveAction(userIdOf, n);
    gh.checkRuns.set(gh.git.get(REPO)!.refs.get(`heads/${workBranchName}`)!, [{ id: 9, name: "test", status: "completed", conclusion: "failure", annotations: [] }]);
    await watchReleasesOnce(at(5 * 60_000));
    expect(await item()).toMatchObject({ status: "failed", errorMessage: RELEASE_MESSAGES.ciFailed("test") });
    expect((await workRow()).status).toBe("open");
    expect(releasePull().merged).toBe(false);
  });

  it("CI ferma per 30 minuti: voce failed", async () => {
    const n = await readyWork();
    await approveAction(userIdOf, n);
    gh.checkRuns.set(gh.git.get(REPO)!.refs.get(`heads/${workBranchName}`)!, [{ id: 9, name: "test", status: "in_progress", conclusion: null, annotations: [] }]);
    await watchReleasesOnce(new Date(Date.now() + 31 * 60_000));
    expect(await item()).toMatchObject({ status: "failed", errorMessage: RELEASE_MESSAGES.ciTimeout });
  });

  it("riavvio con la voce in esecuzione: resta executing e il giro la conclude", async () => {
    const n = await readyWork();
    await approveAction(userIdOf, n);
    await failInterruptedActions();
    expect((await item()).status).toBe("executing");
    greenOn(gh.git.get(REPO)!.refs.get(`heads/${workBranchName}`)!);
    await watchReleasesOnce(at(5 * 60_000));
    expect((await item()).status).toBe("done");
  });

  it("rifiutata con una nota: lavoro di nuovo aperto, nota salvata e turno del capo con la nota", async () => {
    const n = await readyWork();
    const res = await rejectAction(userIdOf, n, "Manca il pulsante Annulla");
    expect(res.ok).toBe(true);
    const work = await workRow();
    expect(work).toMatchObject({ status: "open", rejectionNote: "Manca il pulsante Annulla", pendingActionId: null });
    expect((await reasons()).some((x) => x.type === "request" && x.text.includes("Manca il pulsante Annulla"))).toBe(true);
  });

  it("PR di rilascio che tocca i workflow: failed senza merge", async () => {
    userIdOf = (await db.select().from(usersTable))[0]!.id;
    // Il workflow arriva sul branch del lavoro senza passare dal merge automatico (es. scritto a mano)
    const repo = gh.git.get(REPO)!;
    const head = repo.refs.get(`heads/${workBranchName}`)!;
    const { sha } = await commitFiles(r, { branch: `botcave/${instanceId}-t1`, parentSha: head, baseTreeSha: await getCommitTree(r, head), changes: new Map([[".github/workflows/x.yml", "on: push"]]), message: "wf", createBranch: true });
    repo.refs.set(`heads/${workBranchName}`, sha);
    await db.insert(teamCodeTasksTable).values({ instanceId, planTaskId: "t1", repo: REPO, branch: `botcave/${instanceId}-t1`, baseBranch: workBranchName, headSha: sha, prNumber: 99, prUrl: "u", prState: "merged", workId });
    await closeWorkIfDone(instanceId, { fromLead: true });
    const n = (await item()).number;
    await approveAction(userIdOf, n);
    greenOn(sha);
    await watchReleasesOnce(at(5 * 60_000));
    expect((await item()).status).toBe("failed");
    expect(releasePull().merged).toBe(false);
  });
});

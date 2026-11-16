import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  githubInstallationsTable,
  teamEventsTable,
  teamInstancesTable,
  teamTasksTable,
  teamTurnsTable,
  usersTable,
  type InstanceRoleData,
} from "@workspace/db";
import { encryptSecret } from "../src/lib/secrets";
import { allowTestLoopback, startFakeProvider, type FakeChatReply, type FakeProvider } from "./fake-provider";
import { startFakeGithub, type FakeGithub } from "./fake-github";
import { catalogSkill, ensureUser, nodeRole, seedNodeTeam } from "./team-node-fixture";
import { clearInstallationTokenCache } from "../src/lib/github/app";
import { resetGithubConfigForTests } from "../src/lib/github/config";
import { getCodeTask, upsertCodeTask } from "../src/lib/code-writer/code-tasks";
import { commitFiles, createDraftPull, getBranchHead, getCommitTree } from "../src/lib/code-writer/github-git";
import { MAX_MERGES_PER_HOUR, MERGE_MESSAGES, mergeTeamPull } from "../src/lib/code-writer/merge";
import { approveAction, rejectAction } from "../src/lib/actions/decide";
import { enqueueMergeItem } from "../src/lib/actions/queue";
import { githubConfig } from "../src/lib/github/config";
import { pendingActionsTable, teamCodeTasksTable } from "@workspace/db";
import { watchCodeTasksOnce } from "../src/lib/code-writer/watcher";
import { createNode } from "../src/lib/nodes/nodes";
import { claimTask, gitTokenForTask, heartbeat, reportTask } from "../src/lib/nodes/protocol";
import { getPlan, writePlanVersion } from "../src/lib/teams/plan";
import { settleTaskExecutions, startTask } from "../src/lib/teams/task-runner";

// Prova di flusso degli strumenti GitHub delle squadre: finto provider per il modello del ruolo, finto GitHub con Git,
// PR e CI, PGlite. Il capo si guida passo per passo (assegnazione con startTask, motivi dei turni letti dal DB).

const REPO = "ivan/hub-up";
const INST = 31;
const GH_VARS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
const savedEnv: Record<string, string | undefined> = {};
const PERMISSIONS = { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", issues: "write", metadata: "read" };
const TRUNCATE = "TRUNCATE users, apps, skills, ai_accounts, team_instances RESTART IDENTITY CASCADE";

let gh: FakeGithub;
let fake: FakeProvider;
let script: FakeChatReply[];
let restoreLoopback: () => void;
const savedKey = process.env["CASELLO_SECRET_KEY"];

const text = (content: string): FakeChatReply => ({ content, toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const call = (name: string, args: Record<string, unknown>, id = `c_${name}`): FakeChatReply => ({
  content: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const report = (outcome: string, status = "done") => call("riferisci", { status, outcome }, "c_report");

beforeAll(async () => {
  restoreLoopback = allowTestLoopback();
  gh = await startFakeGithub();
  const values: Record<string, string> = {
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
  };
  for (const name of GH_VARS) {
    savedEnv[name] = process.env[name];
    process.env[name] = values[name];
  }
  resetGithubConfigForTests();
});

afterAll(async () => {
  restoreLoopback();
  for (const name of GH_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  resetGithubConfigForTests();
  await gh.close();
  await pool.query(TRUNCATE);
});

function resetGithub(): void {
  clearInstallationTokenCache();
  gh.requests.length = 0;
  gh.failWith = null;
  gh.installations.clear();
  gh.repos.clear();
  gh.git.clear();
  gh.pulls.clear();
  gh.checkRuns.clear();
  gh.statuses.clear();
  gh.jobLogs.clear();
  gh.issues.clear();
  gh.installationPermissions.clear();
  gh.addInstallation({ id: INST, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(INST, PERMISSIONS);
  gh.seedRepo(REPO, "main", { "README.md": "# Hub\n", "src/a.ts": "export const a = 1;\n" });
}

const reasons = async (instanceId: number) =>
  (await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId))).flatMap((t) => t.reasons).filter((r) => r.type === "ci_finished" || r.type === "pr_closed");
const bulletins = async (instanceId: number) =>
  (await db.select().from(teamEventsTable).where(eq(teamEventsTable.instanceId, instanceId))).sort((a, b) => a.id - b.id).map((e) => `${e.type}: ${e.bulletin}`);

describe("flusso: ruolo cloud con codice", () => {
  let userId: number;
  let modelId: number;
  let instanceId: number;

  beforeEach(async () => {
    process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
    vi.spyOn(console, "log").mockImplementation(() => {});
    script = [];
    fake = await startFakeProvider({ chatReply: () => script.shift() ?? text("fatto") });
    resetGithub();
    gh.issues.set(REPO, [{ number: 7, title: "Valore di a", body: "Portare a da 1 a 2", labels: [], state: "open", stateReason: null, updatedAt: new Date().toISOString() }]);
    await pool.query(TRUNCATE);
    const [u] = await db.insert(usersTable).values({ email: "capo@example.com", name: "Ivan" }).returning();
    userId = u!.id;
    await db.insert(githubInstallationsTable).values({ userId, installationId: INST, accountLogin: "ivan", accountType: "User", repositorySelection: "selected" });
    const [account] = await db
      .insert(aiAccountsTable)
      .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
      .returning();
    const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1000", priceOutputPerMtok: "2000" }).returning();
    modelId = model!.id;
    const [app] = await db
      .insert(appsTable)
      .values({ name: "The Hub Up", slug: "hub-up", baseUrl: "http://hub.example", sourceType: "github", sourceRepo: REPO, sourceInstallationId: INST })
      .returning();
    const base = { runsOn: "cloud" as const, aiModelId: modelId, tools: [], skills: [], localSkills: [] };
    const roles: InstanceRoleData[] = [
      { ...base, key: "capo", name: "Capo", task: "Coordina.", isLead: true },
      { ...base, key: "dev", name: "Sviluppatore", task: "Scrive codice.", isLead: false, code: "write" } as InstanceRoleData,
    ];
    const [inst] = await db
      .insert(teamInstancesTable)
      .values({ name: "Squadra WI", refAppId: app!.id, refType: "wi", refId: "1174", refTitle: "WI 1174", status: "active", roles, createdBy: userId, activatedBy: userId })
      .returning();
    instanceId = inst!.id;
    await writePlanVersion(
      instanceId,
      {
        objective: "Portare a a 2",
        constraints: [],
        openPoints: [],
        manualActions: [],
        tasks: [{ id: "t1", title: "Aggiorna a", roleKey: "dev", instructions: "Cambia a in src/a.ts", status: "planned", outcome: null, issue: 7 }],
      },
      "approved",
    );
  });

  afterEach(async () => {
    await settleTaskExecutions();
    vi.restoreAllMocks();
    await fake.close();
    if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
    else process.env["CASELLO_SECRET_KEY"] = savedKey;
  });

  const runTask = async () => {
    const started = await startTask(instanceId, "t1");
    await settleTaskExecutions();
    const [task] = await db.select().from(teamTasksTable).where(eq(teamTasksTable.id, started.id));
    return task!;
  };

  it("issue → commit e PR → CI rossa → ci_finished → correzione sullo stesso branch → CI verde → merge → pr_closed", async () => {
    const branch = `botcave/${instanceId}-t1`;

    // 1. Prima esecuzione: legge l'issue e il file, modifica, committa, apre la PR
    script = [
      call("leggi_issue", { numero: 7 }),
      call("leggi_file", { percorso: "src/a.ts" }),
      call("modifica_file", { percorso: "src/a.ts", vecchio: "a = 1", nuovo: "a = 3" }),
      call("crea_commit", { messaggio: "Aggiorna a" }),
      call("apri_pr", { titolo: "Aggiorna a", corpo: "Porta a a 3" }),
      report("PR aperta, CI in corso"),
    ];
    const first = await runTask();
    expect(first).toMatchObject({ status: "done", outcome: "PR aperta, CI in corso" });
    const issueResult = JSON.stringify(
      (fake.requests.map((r) => r.body) as { messages?: { role: string; content: string }[] }[]).flatMap((b) => b.messages ?? []).filter((m) => m.role === "tool"),
    );
    expect(issueResult).toContain("Portare a da 1 a 2");
    const pr = gh.pulls.get(REPO)![0]!;
    expect(pr).toMatchObject({ head: branch, base: "main", draft: true, state: "open" });
    expect(pr.body).toContain("Closes #7");
    expect(gh.filesAt(REPO, branch)["src/a.ts"]).toBe("export const a = 3;\n");
    expect(gh.filesAt(REPO, "main")["src/a.ts"]).toBe("export const a = 1;\n");
    const code1 = (await getCodeTask(instanceId, "t1"))!;
    expect(code1).toMatchObject({ prNumber: pr.number, prState: "open", ciState: "pending", branch });
    const sha1 = code1.headSha!;

    // 2. CI rossa: PLAN blocked, evento, turno del capo con ci_finished
    gh.checkRuns.set(sha1, [{ id: 1, name: "test", status: "completed", conclusion: "failure", annotations: [{ path: "src/a.ts", start_line: 1, message: "a deve valere 2" }] }]);
    const t0 = Date.now();
    await watchCodeTasksOnce(new Date(t0 + 60_000));
    expect(await reasons(instanceId)).toEqual([{ type: "ci_finished", taskCodeId: code1.id, outcome: "failure" }]);
    expect((await getPlan(instanceId)).tasks[0]).toMatchObject({ status: "blocked", outcome: "CI non superata: test" });
    expect(await bulletins(instanceId)).toContain(`bloccato: Compito t1: CI non superata sulla PR #${pr.number}`);

    // 3. Riesecuzione sullo stesso branch: legge l'esito della CI, corregge, committa
    script = [
      call("leggi_esito_ci", {}),
      call("modifica_file", { percorso: "src/a.ts", vecchio: "a = 3", nuovo: "a = 2" }),
      call("crea_commit", { messaggio: "Correggi a" }),
      report("corretto, CI in corso"),
    ];
    const before = fake.requests.length;
    const second = await runTask();
    expect(second).toMatchObject({ status: "done", outcome: "corretto, CI in corso" });
    const msgs = (fake.requests.slice(before)[0]!.body as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
    expect(msgs).toContain(`Branch del compito: ${branch}`);
    expect(msgs).toContain("la CI è fallita");
    expect(gh.filesAt(REPO, branch)["src/a.ts"]).toBe("export const a = 2;\n");
    expect(gh.pulls.get(REPO)).toHaveLength(1);
    const sha2 = (await getCodeTask(instanceId, "t1"))!.headSha!;
    expect(sha2).not.toBe(sha1);
    gh.pulls.get(REPO)![0]!.headSha = sha2;

    // 4. CI verde sul nuovo commit
    gh.checkRuns.set(sha2, [{ id: 2, name: "test", status: "completed", conclusion: "success", annotations: [] }]);
    await watchCodeTasksOnce(new Date(t0 + 120_000));
    expect(await bulletins(instanceId)).toContain(`compito_finito: Compito t1: CI verde, PR #${pr.number} pronta per la revisione`);
    expect(await reasons(instanceId)).toContainEqual({ type: "ci_finished", taskCodeId: code1.id, outcome: "success" });
    expect(await getCodeTask(instanceId, "t1")).toMatchObject({ ciState: "success", ciNotifiedSha: sha2 });

    // 5. L'utente unisce la PR su GitHub: pr_closed e fine della sorveglianza
    gh.pulls.get(REPO)![0]!.state = "closed";
    gh.pulls.get(REPO)![0]!.merged = true;
    await watchCodeTasksOnce(new Date(t0 + 180_000));
    expect(await reasons(instanceId)).toContainEqual({ type: "pr_closed", taskCodeId: code1.id, merged: true });
    expect(await bulletins(instanceId)).toContain(`compito_finito: Compito t1: PR #${pr.number} unita`);
    expect((await getCodeTask(instanceId, "t1"))!.prState).toBe("merged");
    const n = (await reasons(instanceId)).length;
    await watchCodeTasksOnce(new Date(t0 + 240_000));
    expect((await reasons(instanceId)).length).toBe(n);
  });
});

describe("flusso: compito node con PR", () => {
  it("report done con una PR sul branch: la riga è sorvegliata e la CI verde si notifica", async () => {
    await pool.query(TRUNCATE);
    resetGithub();
    const userId = await ensureUser("dev@localhost");
    await catalogSkill("sap-abap", "node", "sap:abap-developer");
    const instanceId = await seedNodeTeam({ userId, roles: [nodeRole({ skills: [{ code: "sap-abap", version: 1 }], code: "write" })] });
    await db.update(appsTable).set({ sourceType: "github", sourceRepo: REPO, sourceInstallationId: INST }).where(eq(appsTable.slug, "hub-up"));
    const started = await startTask(instanceId, "t1");
    const { node } = await createNode(userId, "Mac");
    await heartbeat(node.id, { version: "0.4.0", executor: "claude-code", skills: ["sap:abap-developer"], workspaceRoot: "/w", maxConcurrent: 1 });
    const pkg = (await claimTask(node.id))!;
    const branch = `botcave/${instanceId}-t1`;
    expect(pkg.task.instructions).toContain(branch);

    // Il nodo ha lavorato sul branch e aperto la PR con gh
    const head = gh.seedRepo(REPO, branch, { "a.txt": "due" });
    gh.pulls.set(REPO, [{ number: 9, head: branch, base: "main", title: "t", body: "", draft: true, state: "open", merged: false, headSha: head }]);
    await reportTask(node.id, started.id, { leaseToken: pkg.leaseToken, status: "done", outcome: "fatto" });
    const row = await getCodeTask(instanceId, "t1");
    expect(row).toMatchObject({ prNumber: 9, prState: "open", branch });

    gh.checkRuns.set(head, [{ id: 1, name: "build", status: "completed", conclusion: "success", annotations: [] }]);
    await watchCodeTasksOnce(new Date(Date.now() + 60_000));
    expect(await bulletins(instanceId)).toContain(`compito_finito: Compito t1: CI verde, PR #9 pronta per la revisione`);
    expect(await reasons(instanceId)).toEqual([{ type: "ci_finished", taskCodeId: row!.id, outcome: "success" }]);
  });
});

describe("flusso: compito node con codice, PR aperta da Botcave", () => {
  it("claim con git → token → report done con git.pushed → PR in bozza → CI verde → ci_finished", async () => {
    await pool.query(TRUNCATE);
    resetGithub();
    const userId = await ensureUser("dev@localhost");
    await catalogSkill("sap-abap", "node", "sap:abap-developer");
    const instanceId = await seedNodeTeam({ userId, roles: [nodeRole({ skills: [{ code: "sap-abap", version: 1 }], code: "write" })] });
    await db.update(appsTable).set({ sourceType: "github", sourceRepo: REPO, sourceInstallationId: INST }).where(eq(appsTable.slug, "hub-up"));
    await db.insert(githubInstallationsTable).values({ userId, installationId: INST, accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }).onConflictDoNothing();
    const started = await startTask(instanceId, "t1");
    const { node } = await createNode(userId, "Mac");
    await heartbeat(node.id, { version: "0.4.0", executor: "claude-code", skills: ["sap:abap-developer"], workspaceRoot: "/w", maxConcurrent: 1, git: { found: true, version: "2.45.0" } });

    const pkg = (await claimTask(node.id))!;
    const branch = `botcave/${instanceId}-t1`;
    expect(pkg.git).toMatchObject({ repo: REPO, baseBranch: "main", branch });
    expect(pkg.task.instructions).toContain(branch);

    // Token per Git: ristretto al repository, contents: write
    const { token } = await gitTokenForTask(node.id, started.id, pkg.leaseToken);
    expect(token).toBeTruthy();

    // Il nodo ha committato e pubblicato il branch (avanti al base): nessuna PR su GitHub
    const refs = gh.git.get(REPO)!.refs;
    const head = "d".repeat(40);
    refs.set(`heads/${branch}`, head);
    expect(gh.pulls.get(REPO) ?? []).toHaveLength(0);
    await reportTask(node.id, started.id, { leaseToken: pkg.leaseToken, status: "done", outcome: "fatto", git: { pushed: true, headSha: head, commits: 1 } });

    const pr = gh.pulls.get(REPO)![0]!;
    expect(pr).toMatchObject({ head: branch, base: "main", draft: true, state: "open" });
    const row = await getCodeTask(instanceId, "t1");
    expect(row).toMatchObject({ prNumber: pr.number, prState: "open", ciState: "pending", branch });

    gh.checkRuns.set(head, [{ id: 1, name: "build", status: "completed", conclusion: "success", annotations: [] }]);
    await watchCodeTasksOnce(new Date(Date.now() + 60_000));
    expect(await bulletins(instanceId)).toContain(`compito_finito: Compito t1: CI verde, PR #${pr.number} pronta per la revisione`);
    expect(await reasons(instanceId)).toEqual([{ type: "ci_finished", taskCodeId: row!.id, outcome: "success" }]);
  });
});

describe("flusso: merge automatico (code: merge)", () => {
  let userId: number;
  let instanceId: number;

  beforeEach(async () => {
    process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
    vi.spyOn(console, "log").mockImplementation(() => {});
    script = [];
    fake = await startFakeProvider({ chatReply: () => script.shift() ?? text("fatto") });
    resetGithub();
    await pool.query(TRUNCATE);
    const [u] = await db.insert(usersTable).values({ email: "capo@example.com", name: "Ivan" }).returning();
    userId = u!.id;
    await db.insert(githubInstallationsTable).values({ userId, installationId: INST, accountLogin: "ivan", accountType: "User", repositorySelection: "selected" });
    const [account] = await db
      .insert(aiAccountsTable)
      .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
      .returning();
    const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1000", priceOutputPerMtok: "2000" }).returning();
    const [app] = await db
      .insert(appsTable)
      .values({ name: "The Hub Up", slug: "hub-up", baseUrl: "http://hub.example", sourceType: "github", sourceRepo: REPO, sourceInstallationId: INST })
      .returning();
    const base = { runsOn: "cloud" as const, aiModelId: model!.id, tools: [], skills: [], localSkills: [] };
    const roles: InstanceRoleData[] = [
      { ...base, key: "capo", name: "Capo", task: "Coordina.", isLead: true },
      { ...base, key: "dev", name: "Sviluppatore", task: "Scrive e unisce.", isLead: false, code: "merge" },
    ];
    const [inst] = await db
      .insert(teamInstancesTable)
      .values({ name: "Squadra M", refAppId: app!.id, refType: "wi", refId: "1", refTitle: "WI 1", status: "active", roles, createdBy: userId, activatedBy: userId })
      .returning();
    instanceId = inst!.id;
    const task = (id: string) => ({ id, title: `Compito ${id}`, roleKey: "dev", instructions: "Lavora", status: "planned" as const, outcome: null });
    await writePlanVersion(instanceId, { objective: "Merge", constraints: [], openPoints: [], manualActions: [], tasks: [task("t1"), task("t2")] }, "approved");
  });

  afterEach(async () => {
    await settleTaskExecutions();
    vi.restoreAllMocks();
    await fake.close();
    if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
    else process.env["CASELLO_SECRET_KEY"] = savedKey;
  });

  /** PR in bozza del compito con i file dati, senza il modello (commit, PR e riga come gli strumenti del ruolo). */
  const pushPr = async (planTaskId: string, files: Record<string, string>) => {
    const r = { cfg: githubConfig()!, installationId: INST, repo: REPO };
    const branch = `botcave/${instanceId}-${planTaskId}`;
    const mainSha = (await getBranchHead(r, "main"))!;
    const { sha } = await commitFiles(r, {
      branch,
      parentSha: mainSha,
      baseTreeSha: await getCommitTree(r, mainSha),
      changes: new Map(Object.entries(files)),
      message: `Compito ${planTaskId}`,
      createBranch: true,
    });
    const pull = await createDraftPull(r, { head: branch, base: "main", title: `Compito ${planTaskId}`, body: "" });
    await upsertCodeTask({ instanceId, planTaskId, repo: REPO, branch, baseBranch: "main", headSha: sha, pr: { number: pull.number, url: pull.url }, committedAt: new Date() });
    return { sha, number: pull.number };
  };
  const green = (sha: string) => gh.checkRuns.set(sha, [{ id: 1, name: "test", status: "completed", conclusion: "success", annotations: [] }]);
  const pull = (n: number) => gh.pulls.get(REPO)!.find((p) => p.number === n)!;

  it("il ruolo unisce con unisci_pr: CI rossa rifiutata, poi CI verde → bozza tolta, squash sul base → pr_closed", async () => {
    // Il ruolo scrive e apre la PR come un ruolo write
    script = [
      call("modifica_file", { percorso: "src/a.ts", vecchio: "a = 1", nuovo: "a = 2" }),
      call("crea_commit", { messaggio: "Aggiorna a" }),
      call("apri_pr", { titolo: "Aggiorna a", corpo: "Porta a a 2" }),
      report("PR aperta, CI in corso"),
    ];
    const started = await startTask(instanceId, "t1");
    await settleTaskExecutions();
    expect((await db.select().from(teamTasksTable).where(eq(teamTasksTable.id, started.id)))[0]).toMatchObject({ status: "done" });
    const row = (await getCodeTask(instanceId, "t1"))!;
    const pr = pull(row.prNumber!);
    expect(pr.draft).toBe(true);

    // CI rossa: nessun merge
    gh.checkRuns.set(row.headSha!, [{ id: 1, name: "test", status: "completed", conclusion: "failure", annotations: [] }]);
    expect(await mergeTeamPull(instanceId, { compito: "t1" })).toEqual({ ok: false, content: MERGE_MESSAGES.ciFailure });
    gh.checkRuns.delete(row.headSha!);
    expect(await mergeTeamPull(instanceId, { compito: "t1" })).toEqual({ ok: false, content: MERGE_MESSAGES.ciPending });
    expect(pr).toMatchObject({ state: "open", merged: false });

    // CI verde: il ruolo unisce con lo strumento durante un compito
    green(row.headSha!);
    script = [call("unisci_pr", { compito: "t1" }), report("PR unita")];
    const before = fake.requests.length;
    await startTask(instanceId, "t1");
    await settleTaskExecutions();
    const tools = (fake.requests[before]!.body as { tools: { function: { name: string } }[] }).tools.map((t) => t.function.name);
    expect(tools).toContain("unisci_pr");
    expect(pr).toMatchObject({ state: "closed", merged: true, draft: false, mergeMethod: "squash" });
    expect(gh.filesAt(REPO, "main")["src/a.ts"]).toBe("export const a = 2;\n");
    const merge = gh.requests.find((r) => r.method === "PUT" && r.path.endsWith(`/pulls/${pr.number}/merge`))!;
    expect(merge.body).toMatchObject({ merge_method: "squash", sha: row.headSha });
    expect((await getCodeTask(instanceId, "t1"))!.botcaveMergedAt).not.toBeNull();

    // La sorveglianza vede la PR unita: evento e motivo pr_closed come per un merge dell'utente
    await watchCodeTasksOnce(new Date(Date.now() + 60_000));
    expect(await reasons(instanceId)).toContainEqual({ type: "pr_closed", taskCodeId: row.id, merged: true });
    expect(await mergeTeamPull(instanceId, { compito: "t1" })).toEqual({ ok: false, content: MERGE_MESSAGES.alreadyMerged });
  });

  it("PR con una migrazione additiva: si unisce da sola; poi una modifica della migrazione esistente è rifiutata", async () => {
    const add = "CREATE TABLE IF NOT EXISTS x (id int);\n";
    const { sha, number } = await pushPr("t1", { "docs/migrations/2026-11-16-x.sql": add, "docs/schema-casello.sql": "-- x\n", "src/a.ts": "export const a = 5;\n" });
    green(sha);
    expect(await mergeTeamPull(instanceId, { numero: number })).toEqual({ ok: true, content: MERGE_MESSAGES.merged(number, "main") });
    expect(await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.kind, "merge"))).toEqual([]);
    expect(pull(number)).toMatchObject({ state: "closed", merged: true });
    expect(gh.filesAt(REPO, "main")["docs/migrations/2026-11-16-x.sql"]).toBe(add);

    const second = await pushPr("t2", { "docs/migrations/2026-11-16-x.sql": add + "CREATE INDEX IF NOT EXISTS x_idx ON x (id);\n" });
    green(second.sha);
    expect(await mergeTeamPull(instanceId, { compito: "t2" })).toEqual({ ok: false, content: MERGE_MESSAGES.migrationModified });
    expect(pull(second.number).state).toBe("open");
  });

  it("PR con uno script -post → voce merge con l'SQL → approvazione → merge; rifiuto → motivo al capo", async () => {
    const post = "ALTER TABLE x DROP COLUMN IF EXISTS y;\n";
    const { sha, number } = await pushPr("t1", { "docs/migrations/2026-11-16-x-post.sql": post, "src/a.ts": "export const a = 5;\n" });
    green(sha);
    const res = await mergeTeamPull(instanceId, { numero: number });
    expect(res.ok).toBe(false);
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.kind, "merge"));
    expect(item).toMatchObject({ status: "pending", teamInstanceId: instanceId, recipient: REPO, toolId: null, appId: null, summary: MERGE_MESSAGES.summary(number, "t1") });
    expect(res.content).toBe(MERGE_MESSAGES.queued(item!.number, number));
    expect(item!.argsPublic).toMatchObject({
      prNumber: number,
      headSha: sha,
      files: ["docs/migrations/2026-11-16-x-post.sql"],
      postScripts: [{ path: "docs/migrations/2026-11-16-x-post.sql", sql: post }],
    });
    expect(pull(number).state).toBe("open");
    // Una sola voce per PR
    expect(await mergeTeamPull(instanceId, { compito: "t1" })).toEqual({ ok: false, content: MERGE_MESSAGES.alreadyQueued(item!.number, number) });

    const approved = await approveAction(userId, item!.number);
    expect(approved).toMatchObject({ ok: true, action: { status: "done", result: MERGE_MESSAGES.done(number) } });
    expect(MERGE_MESSAGES.done(number)).toBe(`PR #${number} unita: dopo il deploy applica lo script -post`);
    expect(pull(number)).toMatchObject({ state: "closed", merged: true });
    expect(gh.filesAt(REPO, "main")["docs/migrations/2026-11-16-x-post.sql"]).toBe(post);

    // Seconda PR con un -post: rifiutata dall'utente → motivo decision per il capo
    const second = await pushPr("t2", { "docs/migrations/2026-11-16-z-post.sql": "DROP TABLE IF EXISTS z;\n" });
    green(second.sha);
    await mergeTeamPull(instanceId, { compito: "t2" });
    const [item2] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.status, "pending"));
    expect(await rejectAction(userId, item2!.number, "non ora")).toMatchObject({ ok: true });
    const all = (await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId))).flatMap((t) => t.reasons);
    expect(all).toContainEqual({ type: "decision", number: item2!.number, outcome: "rejected", note: "non ora" });
    expect(pull(second.number).state).toBe("open");
  });

  it("schema cambiato senza migrazione: rifiutata alla squadra, nessuna voce", async () => {
    const { sha, number } = await pushPr("t1", { "docs/schema-casello.sql": "-- nuovo\n" });
    green(sha);
    expect(await mergeTeamPull(instanceId, { compito: "t1" })).toEqual({ ok: false, content: MERGE_MESSAGES.schemaWithoutMigration });
    expect(await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.kind, "merge"))).toEqual([]);
    expect(pull(number).state).toBe("open");
  });

  it("approvazione con la testa cambiata dopo la richiesta: voce failed e motivo merge_failed al capo", async () => {
    const { sha, number } = await pushPr("t1", { "lib/db/src/schema/x.ts": "export {};\n", "docs/migrations/2026-11-16-x-post.sql": "DROP TABLE IF EXISTS x;\n" });
    green(sha);
    await mergeTeamPull(instanceId, { compito: "t1" });
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.kind, "merge"));
    // Un commit nuovo sul branch dopo la richiesta
    const r = { cfg: githubConfig()!, installationId: INST, repo: REPO };
    const { sha: newSha } = await commitFiles(r, {
      branch: `botcave/${instanceId}-t1`,
      parentSha: sha,
      baseTreeSha: await getCommitTree(r, sha),
      changes: new Map([["src/b.ts", "x\n"]]),
      message: "altro",
      createBranch: false,
    });
    green(newSha);
    const res = await approveAction(userId, item!.number);
    expect(res).toMatchObject({ ok: true, action: { status: "failed", errorMessage: MERGE_MESSAGES.itemChanged } });
    expect(pull(number).state).toBe("open");
    const code = (await getCodeTask(instanceId, "t1"))!;
    const all = (await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId))).flatMap((t) => t.reasons);
    expect(all).toContainEqual({ type: "merge_failed", taskCodeId: code.id, message: MERGE_MESSAGES.itemChanged });
  });

  it("voce accodata con la regola precedente per una PR con sola migrazione additiva: l'approvazione unisce", async () => {
    const add = "CREATE TABLE IF NOT EXISTS w (id int);\n";
    const { sha, number } = await pushPr("t1", { "docs/migrations/2026-11-16-w.sql": add, "docs/schema-casello.sql": "-- w\n" });
    green(sha);
    const row = (await getCodeTask(instanceId, "t1"))!;
    // Voce come quelle scritte prima di questo ramo (oggi la stessa PR si unirebbe da sola)
    const queued = await enqueueMergeItem({
      userId,
      instanceId,
      recipient: REPO,
      summary: MERGE_MESSAGES.summary(number, "t1"),
      detail: { taskCodeId: row.id, planTaskId: "t1", repo: REPO, prNumber: number, prUrl: "", headSha: sha, baseBranch: "main", files: ["docs/migrations/2026-11-16-w.sql"] },
    });
    expect(queued.ok).toBe(true);
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.kind, "merge"));
    expect(await approveAction(userId, item!.number)).toMatchObject({ ok: true, action: { status: "done" } });
    expect(pull(number)).toMatchObject({ state: "closed", merged: true });
  });

  it("rifiuti: workflow della CI, testa cambiata dall'ultimo controllo, limite orario, PR di un'altra squadra", async () => {
    const wf = await pushPr("t1", { ".github/workflows/ci.yml": "on: push\n" });
    green(wf.sha);
    expect(await mergeTeamPull(instanceId, { compito: "t1" })).toEqual({ ok: false, content: MERGE_MESSAGES.workflows });

    const p2 = await pushPr("t2", { "src/c.ts": "c\n" });
    green(p2.sha);
    // La riga ha una testa diversa (la sorveglianza non ha ancora visto il commit)
    await db.update(teamCodeTasksTable).set({ headSha: "f".repeat(40) }).where(eq(teamCodeTasksTable.planTaskId, "t2"));
    expect(await mergeTeamPull(instanceId, { compito: "t2" })).toEqual({ ok: false, content: MERGE_MESSAGES.headMoved });
    await db.update(teamCodeTasksTable).set({ headSha: p2.sha }).where(eq(teamCodeTasksTable.planTaskId, "t2"));

    // Limite orario: altri merge della squadra nell'ultima ora
    const now = new Date();
    for (let i = 0; i < MAX_MERGES_PER_HOUR; i++) {
      await db.insert(teamCodeTasksTable).values({ instanceId, planTaskId: `x${i}`, repo: REPO, branch: `botcave/${instanceId}-x${i}`, baseBranch: "main", botcaveMergedAt: now });
    }
    expect(await mergeTeamPull(instanceId, { compito: "t2" })).toEqual({ ok: false, content: MERGE_MESSAGES.tooManyMerges });
    expect(pull(p2.number).state).toBe("open");

    // Argomenti e PR non della squadra
    expect(await mergeTeamPull(instanceId, {})).toEqual({ ok: false, content: MERGE_MESSAGES.badArgs });
    expect(await mergeTeamPull(instanceId, { numero: 999 })).toEqual({ ok: false, content: MERGE_MESSAGES.noPull("la PR #999") });
    await db.update(teamCodeTasksTable).set({ branch: "botcave/999-t2" }).where(eq(teamCodeTasksTable.planTaskId, "t2"));
    expect(await mergeTeamPull(instanceId, { compito: "t2" })).toEqual({ ok: false, content: MERGE_MESSAGES.notTeamBranch });
  });
});

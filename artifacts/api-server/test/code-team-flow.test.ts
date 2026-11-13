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
import { getCodeTask } from "../src/lib/code-writer/code-tasks";
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

    // Il nodo ha committato e pubblicato il branch: nessuna PR su GitHub
    const refs = gh.git.get(REPO)!.refs;
    const head = refs.get("heads/main")!;
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

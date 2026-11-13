import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appsTable, db, githubInstallationsTable, pool, teamTasksTable } from "@workspace/db";
import { catalogSkill, ensureUser, nodeRole, seedNodeTeam } from "../../../test/team-node-fixture";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { createNode } from "../nodes/nodes";
import { claimTask, heartbeat, reportTask } from "../nodes/protocol";
import { startTask } from "../teams/task-runner";
import { getCodeTask } from "./code-tasks";
import { getApprovedPlan, getPlan, writePlanVersion } from "../teams/plan";
import { nodeGitSection, nodePullBody } from "./node-git";

// Compiti node con codice: sezione Git nel pacchetto e PR adottata al report `done` (PGlite + finto GitHub)

const REPO = "ivan/mister";
const ENV_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
const saved: Record<string, string | undefined> = {};
let gh: FakeGithub;
let userId: number;

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
});

afterAll(async () => {
  await gh.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await pool.query("TRUNCATE users, apps, skills, team_instances RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, skills, team_instances RESTART IDENTITY CASCADE");
  clearInstallationTokenCache();
  gh.pulls.clear();
  gh.installationPermissions.clear();
  gh.requests.length = 0;
  userId = await ensureUser("dev@localhost");
  await catalogSkill("sap-abap", "node", "sap:abap-developer");
  gh.addInstallation({ id: 7, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(7, { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", issues: "write", metadata: "read" });
  gh.seedRepo(REPO, "main", { "a.txt": "uno" });
});

async function setup(opts: { withRepo?: boolean; code?: "none" | "write"; sourceBranch?: string | null } = {}) {
  const role = nodeRole({ skills: [{ code: "sap-abap", version: 1 }], code: opts.code ?? "write" });
  const instanceId = await seedNodeTeam({ userId, roles: [role] });
  if (opts.withRepo !== false) {
    await db
      .update(appsTable)
      .set({ sourceType: "github", sourceRepo: REPO, sourceInstallationId: 7, sourceBranch: opts.sourceBranch ?? null })
      .where(eq(appsTable.slug, "hub-up"));
  }
  const started = await startTask(instanceId, "t1");
  const { node } = await createNode(userId, "Mac");
  await heartbeat(node.id, { version: "0.4.0", executor: "claude-code", skills: ["sap:abap-developer"], workspaceRoot: "/w", maxConcurrent: 1 });
  const pkg = (await claimTask(node.id))!;
  return { instanceId, nodeId: node.id, taskId: started.id, pkg };
}

describe("nodeGitSection", () => {
  it("nodeGitSection non parla più di gh pr create e dice di non fare push", () => {
    const s = nodeGitSection({ repo: REPO, baseBranch: "main", branch: "botcave/3-t1", issue: 12 });
    expect(s).toContain("`ivan/mister`");
    expect(s).toContain("Issue: #12");
    expect(s).not.toContain("gh pr create");
    expect(s).toContain("Non fare push, non aprire PR");
    expect(s).toContain("botcave/3-t1");
  });
  it("senza issue niente riga Issue", () => {
    expect(nodeGitSection({ repo: REPO, baseBranch: "main", branch: "botcave/3-t1", issue: null })).not.toContain("Issue:");
  });
});

describe("pacchetto del claim", () => {
  it("ruolo code write: sezione Git con branch e campo git", async () => {
    const { instanceId, pkg } = await setup();
    expect(pkg.task.instructions.startsWith("Istruzioni di t1")).toBe(true);
    expect(pkg.task.instructions).toContain(`botcave/${instanceId}-t1`);
    expect(pkg.task.instructions).not.toContain("gh pr create");
    expect(pkg.git).toEqual({ repo: REPO, baseBranch: "main", branch: `botcave/${instanceId}-t1`, issue: null });
  });
  it("senza code write o senza repository: istruzioni invariate", async () => {
    expect((await setup({ code: "none" })).pkg.task.instructions).toBe("Istruzioni di t1");
    await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
    userId = await ensureUser("dev@localhost");
    expect((await setup({ withRepo: false })).pkg.task.instructions).toBe("Istruzioni di t1");
  });
});

describe("claim con un errore del repository", () => {
  // t1 del ruolo con codice (repository non accessibile), t2 di un ruolo senza codice: il secondo non resta bloccato
  async function twoTasks(installationId: number) {
    const skills = [{ code: "sap-abap", version: 1 }];
    const roles = [nodeRole({ skills, code: "write" }), nodeRole({ key: "semplice", name: "Semplice", skills })];
    const instanceId = await seedNodeTeam({ userId, roles, tasks: { t1: "operaio", t2: "semplice" } });
    await db
      .update(appsTable)
      .set({ sourceType: "github", sourceRepo: REPO, sourceInstallationId: installationId, sourceBranch: null })
      .where(eq(appsTable.slug, "hub-up"));
    const first = await startTask(instanceId, "t1");
    const second = await startTask(instanceId, "t2");
    const { node } = await createNode(userId, "Mac");
    await heartbeat(node.id, { version: "0.4.0", executor: "claude-code", skills: ["sap:abap-developer"], workspaceRoot: "/w", maxConcurrent: 1 });
    return { instanceId, nodeId: node.id, first, second };
  }
  const row = async (id: number) => (await db.select().from(teamTasksTable).where(eq(teamTasksTable.id, id)))[0]!;

  it("installazione revocata: il compito con codice si chiude blocked e il nodo prende quello dopo", async () => {
    const { instanceId, nodeId, first, second } = await twoTasks(99);
    const pkg = await claimTask(nodeId);
    expect(pkg?.taskId).toBe(second.id);
    expect(await row(first.id)).toMatchObject({ status: "blocked", outcome: "accesso al repository non disponibile", leaseToken: null });
    expect((await getPlan(instanceId)).tasks.find((t) => t.id === "t1")).toMatchObject({ status: "blocked", outcome: "accesso al repository non disponibile" });
  });

  it("GitHub non raggiungibile: il compito con codice torna in attesa e il nodo prende quello dopo", async () => {
    const { nodeId, first, second } = await twoTasks(7);
    gh.failWith = () => 500;
    try {
      const pkg = await claimTask(nodeId);
      expect(pkg?.taskId).toBe(second.id);
    } finally {
      gh.failWith = null;
    }
    expect(await row(first.id)).toMatchObject({ status: "waiting_node", leaseToken: null });
  });
});

describe("nodePullBody", () => {
  it("issue, esito e piè di pagina", () => {
    expect(nodePullBody({ issue: 7, outcome: "fatto", teamName: "Squadra WI", planTaskId: "t1" })).toBe(
      "Closes #7\n\nfatto\n\nBotcave · squadra Squadra WI · compito t1",
    );
  });
  it("senza issue né esito solo il piè di pagina; credenziale: solo il piè di pagina", () => {
    expect(nodePullBody({ issue: null, outcome: "", teamName: "S", planTaskId: "t1" })).toBe("Botcave · squadra S · compito t1");
    expect(nodePullBody({ issue: 7, outcome: "chiave ghp_abcdefghijklmnopqrstuvwx", teamName: "S", planTaskId: "t1" })).toBe("Botcave · squadra S · compito t1");
  });
});

describe("report done", () => {
  const report = (nodeId: number, taskId: number, pkg: { leaseToken: string }, status: "done" | "failed" = "done", git?: { pushed: boolean; headSha: string | null; commits: number }) =>
    reportTask(nodeId, taskId, { leaseToken: pkg.leaseToken, status, outcome: "fatto", ...(git ? { git } : {}) });
  // Aggiunge il branch al repository finto senza perdere il base (seedRepo lo riscrive da capo)
  const seedBranch = (branch: string) => {
    const refs = gh.git.get(REPO)!.refs;
    const sha = refs.get("heads/main")!;
    refs.set(`heads/${branch}`, sha);
    return sha;
  };
  const pushedGit = (sha: string) => ({ pushed: true, headSha: sha, commits: 1 });

  it("pushed e branch su GitHub senza PR: crea la PR bozza con issue, esito e piè di pagina", async () => {
    const { instanceId, nodeId, taskId, pkg } = await setup({ sourceBranch: "main" });
    const plan = (await getApprovedPlan(instanceId))!;
    await writePlanVersion(instanceId, { ...plan, tasks: plan.tasks.map((t) => ({ ...t, issue: 7 })) }, "approved");
    const branch = `botcave/${instanceId}-t1`;
    const head = seedBranch(branch);
    await report(nodeId, taskId, pkg, "done", pushedGit(head));
    const pull = gh.pulls.get(REPO)![0]!;
    expect(pull).toMatchObject({ head: branch, base: "main", title: "Compito t1", draft: true });
    expect(pull.body.startsWith("Closes #7")).toBe(true);
    expect(pull.body).toContain("fatto");
    expect(pull.body.endsWith("Botcave · squadra Squadra WI · compito t1")).toBe(true);
    expect(await getCodeTask(instanceId, "t1")).toMatchObject({ prNumber: pull.number, prState: "open", ciState: "pending", headSha: head });
  });

  it("PR già aperta: adottata, nessuna creazione", async () => {
    const { instanceId, nodeId, taskId, pkg } = await setup({ sourceBranch: "main" });
    const branch = `botcave/${instanceId}-t1`;
    const head = seedBranch(branch);
    gh.pulls.set(REPO, [{ number: 5, head: branch, base: "main", title: "t", body: "", draft: true, state: "open", merged: false, headSha: head }]);
    await report(nodeId, taskId, pkg, "done", pushedGit(head));
    expect(gh.pulls.get(REPO)).toHaveLength(1);
    expect(await getCodeTask(instanceId, "t1")).toMatchObject({ prNumber: 5, ciState: "pending" });
  });

  it("git.pushed false o assente: nessuna PR", async () => {
    const { instanceId, nodeId, taskId, pkg } = await setup({ sourceBranch: "main" });
    const head = seedBranch(`botcave/${instanceId}-t1`);
    await report(nodeId, taskId, pkg, "done", { pushed: false, headSha: head, commits: 0 });
    expect(gh.pulls.get(REPO) ?? []).toHaveLength(0);
    expect(await getCodeTask(instanceId, "t1")).toBeNull();
  });

  it("esito che sembra una credenziale: PR col solo piè di pagina", async () => {
    const { instanceId, nodeId, taskId, pkg } = await setup({ sourceBranch: "main" });
    const head = seedBranch(`botcave/${instanceId}-t1`);
    await reportTask(nodeId, taskId, { leaseToken: pkg.leaseToken, status: "done", outcome: "token ghp_abcdefghijklmnopqrstuvwx", git: pushedGit(head) });
    expect(gh.pulls.get(REPO)![0]!.body).toBe("Botcave · squadra Squadra WI · compito t1");
  });

  it("report failed con branch pubblicato: nessuna PR", async () => {
    const { instanceId, nodeId, taskId, pkg } = await setup({ sourceBranch: "main" });
    const head = seedBranch(`botcave/${instanceId}-t1`);
    await report(nodeId, taskId, pkg, "failed", pushedGit(head));
    expect(gh.pulls.get(REPO) ?? []).toHaveLength(0);
  });

  it("con una PR aperta sul branch e senza campo git crea la riga da sorvegliare", async () => {
    const { instanceId, nodeId, taskId, pkg } = await setup({ sourceBranch: "main" });
    const branch = `botcave/${instanceId}-t1`;
    const head = gh.seedRepo(REPO, branch, { "a.txt": "due" });
    gh.pulls.set(REPO, [{ number: 5, head: branch, base: "main", title: "t", body: "", draft: true, state: "open", merged: false, headSha: head }]);
    await report(nodeId, taskId, pkg);
    const row = await getCodeTask(instanceId, "t1");
    expect(row).toMatchObject({ prNumber: 5, prState: "open", ciState: "pending", branch, baseBranch: "main", headSha: head, repo: REPO });
    expect(row!.lastCommitAt).not.toBeNull();
  });

  it("senza PR nessuna riga; un report failed non cerca la PR", async () => {
    const { instanceId, nodeId, taskId, pkg } = await setup();
    await report(nodeId, taskId, pkg);
    expect(await getCodeTask(instanceId, "t1")).toBeNull();
  });

  it("errore di GitHub: il report riesce comunque", async () => {
    const { instanceId, nodeId, taskId, pkg } = await setup();
    const head = seedBranch(`botcave/${instanceId}-t1`);
    gh.failWith = () => 500;
    await report(nodeId, taskId, pkg, "done", pushedGit(head));
    expect(await getCodeTask(instanceId, "t1")).toBeNull();
    gh.failWith = null;
  });
});

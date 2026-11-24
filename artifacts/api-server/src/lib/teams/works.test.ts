import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appsTable, db, githubInstallationsTable, pool, teamCodeTasksTable, teamInstancesTable, teamTasksTable, teamWorksTable } from "@workspace/db";
import { catalogSkill, ensureUser, nodeRole, seedNodeTeam } from "../../../test/team-node-fixture";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { createNode } from "../nodes/nodes";
import { claimTask, heartbeat } from "../nodes/protocol";
import { upsertCodeTask } from "../code-writer/code-tasks";
import { startTask } from "./task-runner";
import { WORK_MESSAGES, codeQueueBlock, ensureWorkForCodeTask, getOpenWork, workBaseFor, workBranch } from "./works";

// Lavoro su branch unico: apertura del branch dalla testa del base, fila dei compiti con codice, base dei compiti node
// (PGlite + finto GitHub)

const REPO = "ivan/mister";
const ENV_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
const saved: Record<string, string | undefined> = {};
let gh: FakeGithub;
let userId: number;
let mainSha: string;

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
  userId = await ensureUser("dev@localhost");
  await catalogSkill("sap-abap", "node", "sap:abap-developer");
  gh.addInstallation({ id: 7, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(7, { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", issues: "write", metadata: "read" });
  mainSha = gh.seedRepo(REPO, "main", { "a.txt": "uno" });
  await db.insert(githubInstallationsTable).values({ userId, installationId: 7, accountLogin: "ivan", accountType: "User", repositorySelection: "all" });
});

async function instanceRow(id: number) {
  const [row] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, id));
  return row;
}

async function queue(instanceId: number, workId: number) {
  const row = (await instanceRow(instanceId))!;
  return db.transaction((tx) => codeQueueBlock(row, workId, tx));
}

/** Squadra con due ruoli node che scrivono codice (t1, t2) e uno senza codice (t3). */
async function team(): Promise<number> {
  const skills = [{ code: "sap-abap", version: 1 }];
  const instanceId = await seedNodeTeam({
    userId,
    roles: [
      nodeRole({ key: "dev", name: "Dev", skills, code: "write" }),
      nodeRole({ key: "dev2", name: "Dev 2", skills, code: "write" }),
      nodeRole({ key: "doc", name: "Documentazione", skills, code: "none" }),
    ],
    tasks: { t1: "dev", t2: "dev2", t3: "doc" },
  });
  await db.update(appsTable).set({ sourceType: "github", sourceRepo: REPO, sourceInstallationId: 7 }).where(eq(appsTable.slug, "hub-up"));
  return instanceId;
}

describe("ensureWorkForCodeTask", () => {
  it("apre il lavoro 1 con il branch creato dalla testa del base e poi lo riusa", async () => {
    const instanceId = await team();
    const work = await ensureWorkForCodeTask((await instanceRow(instanceId))!);
    expect(work).toMatchObject({ number: 1, status: "open", branch: workBranch(instanceId, 1), baseBranch: "main", baseSha: mainSha, repo: REPO });
    expect(gh.git.get(REPO)!.refs.get(`heads/${workBranch(instanceId, 1)}`)).toBe(mainSha);
    const again = await ensureWorkForCodeTask((await instanceRow(instanceId))!);
    expect(again.id).toBe(work.id);
  });

  it("due aperture concorrenti: un solo lavoro", async () => {
    const instanceId = await team();
    const row = (await instanceRow(instanceId))!;
    const [a, b] = await Promise.all([ensureWorkForCodeTask(row), ensureWorkForCodeTask(row)]);
    expect(a.id).toBe(b.id);
    expect(await db.select().from(teamWorksTable)).toHaveLength(1);
  });
});

describe("fila dei compiti con codice", () => {
  it("un compito con codice in corso blocca il secondo, non quelli senza codice", async () => {
    const instanceId = await team();
    const work = await ensureWorkForCodeTask((await instanceRow(instanceId))!);
    await startTask(instanceId, "t1");
    expect(await queue(instanceId, work.id)).toBe(WORK_MESSAGES.queueBusy);
    // t3 è di un ruolo senza codice: la fila non lo riguarda (codeQueueBlock si chiede solo per i ruoli che scrivono)
    await startTask(instanceId, "t3");
  });

  it("compito finito con la PR del lavoro ancora aperta: ancora in fila; PR unita: libero", async () => {
    const instanceId = await team();
    const work = await ensureWorkForCodeTask((await instanceRow(instanceId))!);
    const started = await startTask(instanceId, "t1");
    await db.update(teamTasksTable).set({ status: "done" }).where(eq(teamTasksTable.id, started.id));
    await upsertCodeTask({ instanceId, planTaskId: "t1", repo: REPO, branch: `botcave/${instanceId}-t1`, baseBranch: work.branch, headSha: mainSha, pr: { number: 5, url: "u" } });
    const [row] = await db.select().from(teamCodeTasksTable);
    expect(row!.workId).toBe(work.id);
    expect(await queue(instanceId, work.id)).toBe(WORK_MESSAGES.queueBusy);
    await db.update(teamCodeTasksTable).set({ prState: "merged" });
    expect(await queue(instanceId, work.id)).toBeNull();
  });

  it("riga senza lavoro (PR verso il base dell'App): nessun work_id e nessuna fila", async () => {
    const instanceId = await team();
    await upsertCodeTask({ instanceId, planTaskId: "t1", repo: REPO, branch: `botcave/${instanceId}-t1`, baseBranch: "main", headSha: mainSha, pr: { number: 6, url: "u" } });
    const [row] = await db.select().from(teamCodeTasksTable);
    expect(row!.workId).toBeNull();
    expect(await getOpenWork(instanceId)).toBeNull();
  });
});

describe("compito node con codice nel lavoro", () => {
  it("il pacchetto ha come base il branch del lavoro", async () => {
    const instanceId = await team();
    const work = await ensureWorkForCodeTask((await instanceRow(instanceId))!);
    await startTask(instanceId, "t1");
    const { node } = await createNode(userId, "Mac");
    await heartbeat(node.id, { version: "0.4.0", executor: "claude-code", skills: ["sap:abap-developer"], workspaceRoot: "/w", maxConcurrent: 1 });
    const pkg = (await claimTask(node.id))!;
    expect(pkg.git?.baseBranch).toBe(work.branch);
  });
});

describe("assegna_compito con il lavoro su branch unico", () => {
  async function assign(instanceId: number, taskId: string) {
    const { LEAD_TOOLS, leadToolHandler } = await import("./lead-tools");
    const tool = LEAD_TOOLS.find((t) => t.name === "assegna_compito")!;
    return leadToolHandler({ instanceId, userId, teamName: "Squadra WI", roleKeys: ["dev", "dev2", "doc"] })(tool, { taskId });
  }

  it("il primo compito con codice apre il lavoro, il secondo resta in fila, quello senza codice parte", async () => {
    const instanceId = await team();
    const first = await assign(instanceId, "t1");
    expect(first.ok, first.content).toBe(true);
    expect(await getOpenWork(instanceId)).toMatchObject({ number: 1 });
    const second = await assign(instanceId, "t2");
    expect(second).toMatchObject({ ok: false, content: WORK_MESSAGES.queueBusy });
    const doc = await assign(instanceId, "t3");
    expect(doc.ok, doc.content).toBe(true);
  });
});

describe("correzioni della revisione finale", () => {
  async function lead(instanceId: number, name: string, args: Record<string, unknown>) {
    const { LEAD_TOOLS, leadToolHandler } = await import("./lead-tools");
    return leadToolHandler({ instanceId, userId, teamName: "Squadra WI", roleKeys: ["dev", "dev2", "doc"] })(LEAD_TOOLS.find((t) => t.name === name)!, args);
  }

  it("C1: la PR aperta di un compito non blocca la sua riassegnazione, blocca gli altri", async () => {
    const instanceId = await team();
    const work = await ensureWorkForCodeTask((await instanceRow(instanceId))!);
    await upsertCodeTask({ instanceId, planTaskId: "t1", repo: REPO, branch: `botcave/${instanceId}-t1`, baseBranch: work.branch, headSha: mainSha, pr: { number: 5, url: "u" } });
    const row = (await instanceRow(instanceId))!;
    expect(await db.transaction((tx) => codeQueueBlock(row, work.id, tx, "t1"))).toBeNull();
    expect(await db.transaction((tx) => codeQueueBlock(row, work.id, tx, "t2"))).toBe(WORK_MESSAGES.queueBusy);
    const again = await lead(instanceId, "assegna_compito", { taskId: "t1" });
    expect(again.ok, again.content).toBe(true);
  });

  it("I2: con il lavoro in attesa di Porta in produzione non si assegnano compiti con codice", async () => {
    const instanceId = await team();
    const work = await ensureWorkForCodeTask((await instanceRow(instanceId))!);
    await db.update(teamWorksTable).set({ status: "awaiting_release" }).where(eq(teamWorksTable.id, work.id));
    expect(await lead(instanceId, "assegna_compito", { taskId: "t1" })).toMatchObject({ ok: false, content: WORK_MESSAGES.workNotOpen });
    // Un compito senza codice parte comunque
    expect((await lead(instanceId, "assegna_compito", { taskId: "t3" })).ok).toBe(true);
  });

  it("I2: chiudi_lavoro con un compito con codice ancora in corso è rifiutato", async () => {
    const instanceId = await team();
    await ensureWorkForCodeTask((await instanceRow(instanceId))!);
    await startTask(instanceId, "t1");
    expect(await lead(instanceId, "chiudi_lavoro", { bulletin: "fatto" })).toMatchObject({ ok: false, content: WORK_MESSAGES.closeBusy });
    expect((await getOpenWork(instanceId))!.status).toBe("open");
  });

  it("chiudi_lavoro con una PR del lavoro in attesa del merge (CI in corso o verde) è rifiutato; con la CI rossa no", async () => {
    const instanceId = await team();
    const work = await ensureWorkForCodeTask((await instanceRow(instanceId))!);
    await upsertCodeTask({ instanceId, planTaskId: "t1", repo: REPO, branch: `botcave/${instanceId}-t1`, baseBranch: work.branch, headSha: mainSha, pr: { number: 5, url: "u" } });
    expect(await lead(instanceId, "chiudi_lavoro", { bulletin: "fatto" })).toMatchObject({ ok: false, content: WORK_MESSAGES.closePullPending });
    await db.update(teamCodeTasksTable).set({ ciState: "success" }).where(eq(teamCodeTasksTable.planTaskId, "t1"));
    expect(await lead(instanceId, "chiudi_lavoro", { bulletin: "fatto" })).toMatchObject({ ok: false, content: WORK_MESSAGES.closePullPending });
    expect((await getOpenWork(instanceId))!.status).toBe("open");
    // CI rossa: la PR resta fuori, il capo può chiudere (nessuna PR unita → lavoro abbandonato)
    await db.update(teamCodeTasksTable).set({ ciState: "failure" }).where(eq(teamCodeTasksTable.planTaskId, "t1"));
    expect((await lead(instanceId, "chiudi_lavoro", { bulletin: "fatto" })).ok).toBe(true);
  });

  it("I4: un compito con una PR di prima della 3b (verso main) resta sul base e non apre un lavoro", async () => {
    const instanceId = await team();
    await upsertCodeTask({ instanceId, planTaskId: "t1", repo: REPO, branch: `botcave/${instanceId}-t1`, baseBranch: "main", headSha: mainSha, pr: { number: 6, url: "u" } });
    expect(await workBaseFor(instanceId, "t1")).toBe("main");
    const out = await lead(instanceId, "assegna_compito", { taskId: "t1" });
    expect(out.ok, out.content).toBe(true);
    expect(await getOpenWork(instanceId)).toBeNull();
    const { node } = await createNode(userId, "Mac");
    await heartbeat(node.id, { version: "0.4.0", executor: "claude-code", skills: ["sap:abap-developer"], workspaceRoot: "/w", maxConcurrent: 1 });
    expect((await claimTask(node.id))!.git?.baseBranch).toBe("main");
  });

  it("I5: senza l'installazione di chi ha attivato la squadra niente lavoro né branch", async () => {
    const instanceId = await team();
    await db.delete(githubInstallationsTable);
    await expect(ensureWorkForCodeTask((await instanceRow(instanceId))!)).rejects.toThrow(WORK_MESSAGES.noAccess);
    expect(gh.git.get(REPO)!.refs.get(`heads/${workBranch(instanceId, 1)}`)).toBeUndefined();
  });
});

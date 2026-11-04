import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, nodesTable, pool, teamEventsTable, teamInstancesTable, teamTasksTable, teamTurnsTable } from "@workspace/db";
import { getPlan } from "../lib/teams/plan";
import { startTask } from "../lib/teams/task-runner";
import { teamSpend } from "../lib/teams/team-budget";
import { catalogSkill, ensureUser, nodeRole, seedNodeTeam } from "../../test/team-node-fixture";

// Protocollo dei nodi sull'app completa (porta 0): heartbeat, claim, ping e report con il token d'ambito `node`.
// Le tabelle si svuotano SENZA ripartire con gli id: i limiti per nodo e per compito sono in memoria per id.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"];
const saved: Record<string, string | undefined> = {};
const LEASE_MSG = "lease non valida o scaduta";

let base: string;
let server: http.Server;
let createNode: typeof import("../lib/nodes/nodes").createNode;
let userId: number;
let otherUserId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.includes("application/json") ?? false;
  return { status: res.status, text, json: isJson && text ? JSON.parse(text) : undefined };
}

const caps = (skills: string[], over: Record<string, unknown> = {}) => ({
  version: "0.1.0",
  executor: "claude-code",
  skills,
  workspaceRoot: "/Users/ivan/Progetti",
  maxConcurrent: 1,
  ...over,
});

/** Nodo dell'utente con le capacità dichiarate da un heartbeat. */
async function nodeWith(owner: number, name: string, skills: string[], over: Record<string, unknown> = {}): Promise<{ id: number; token: string }> {
  const { node, token } = await createNode(owner, name);
  const hb = await api("POST", "/node/heartbeat", { token, body: caps(skills, over) });
  expect(hb.status, hb.text).toBe(200);
  return { id: node.id, token };
}

const taskRow = async (id: number) => (await db.select().from(teamTasksTable).where(eq(teamTasksTable.id, id)))[0]!;
const turns = (instanceId: number) => db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId));
const events = (instanceId: number) => db.select().from(teamEventsTable).where(eq(teamEventsTable.instanceId, instanceId));

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: "dev@localhost,altro@example.com", CASELLO_SECRET_KEY: "a".repeat(64) });
  const { default: app } = await import("../app");
  ({ createNode } = await import("../lib/nodes/nodes"));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users, apps, skills, team_instances RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, skills, team_instances CASCADE");
  userId = await ensureUser("dev@localhost");
  otherUserId = await ensureUser("altro@example.com");
  await catalogSkill("sap-abap", "node", "sap:abap-developer");
  await catalogSkill("guida", "casello", "Scrivi sempre i test.");
});

const sapRole = (over = {}) => nodeRole({ skills: [{ code: "sap-abap", version: 1 }, { code: "guida", version: 1 }], ...over });

describe("heartbeat", () => {
  it("aggiorna capacità e last_seen_at; pending = compiti che il nodo potrebbe prendere", async () => {
    const { node, token } = await createNode(userId, "Mac");
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()], tasks: { t1: "operaio", t2: "operaio" } });
    await startTask(instanceId, "t1");
    await startTask(instanceId, "t2");

    const hb = await api("POST", "/node/heartbeat", { token, body: caps(["sap:abap-developer", "altro"], { maxConcurrent: 2 }) });
    expect(hb.status, hb.text).toBe(200);
    expect(hb.json).toEqual({ pending: 2 });
    const [row] = await db.select().from(nodesTable).where(eq(nodesTable.id, node.id));
    expect(row).toMatchObject({ version: "0.1.0", executor: "claude-code", skills: ["sap:abap-developer", "altro"], workspaceRoot: "/Users/ivan/Progetti", maxConcurrent: 2 });
    expect(row!.lastSeenAt).not.toBeNull();

    // Senza la skill del ruolo nulla da prendere
    const other = await createNode(userId, "Altro Mac");
    expect((await api("POST", "/node/heartbeat", { token: other.token, body: caps(["altro"]) })).json).toEqual({ pending: 0 });
  });

  it("corpo non valido → 400; il 7° heartbeat nel minuto → 429", async () => {
    const { token } = await createNode(userId, "Mac");
    expect((await api("POST", "/node/heartbeat", { token, body: caps([], { maxConcurrent: 4 }) })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await api("POST", "/node/heartbeat", { token, body: caps([]) })).status).toBe(200);
    const limited = await api("POST", "/node/heartbeat", { token, body: caps([]) });
    expect(limited.status).toBe(429);
  });
});

describe("claim", () => {
  it("pacchetto completo; il compito passa a running con lease di 15 minuti e il PLAN lo segna in corso", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()] });
    const started = await startTask(instanceId, "t1");
    const { id: nodeId, token } = await nodeWith(userId, "Mac", ["sap:abap-developer"]);

    const before = Date.now();
    const claim = await api("POST", "/node/claim", { token });
    expect(claim.status, claim.text).toBe(200);
    const pkg = claim.json;
    expect(pkg).toMatchObject({
      taskId: started.id,
      team: { id: instanceId, name: "Squadra WI", refType: "wi", refId: "1174", refTitle: "WI 1174" },
      workspace: "SAP/AIMAG/WI_1174",
      role: { key: "operaio", name: "Operaio SAP", task: "Sviluppa in ABAP.", preferredModel: null },
      task: { planTaskId: "t1", title: "Compito t1", instructions: "Istruzioni di t1" },
      plan: {
        objective: "Chiudere il WI",
        constraints: ["Niente trasporti in produzione"],
        openPoints: ["Quale società?"],
        manualActions: [{ id: "m1", text: "Aprire la CR", done: true }],
      },
      caselloSkills: [{ code: "guida", version: 1, content: "Scrivi sempre i test." }],
      nodeSkills: ["sap:abap-developer"],
      attachments: [],
    });
    expect(pkg.plan.tasks).toEqual([{ id: "t1", title: "Compito t1", roleKey: "operaio", status: "running", outcome: null }]);
    expect(typeof pkg.leaseToken).toBe("string");
    expect(pkg.leaseToken.length).toBeGreaterThanOrEqual(32);
    const expires = new Date(pkg.leaseExpiresAt).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 15 * 60_000 - 1_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1_000);

    expect(await taskRow(started.id)).toMatchObject({ status: "running", nodeId, leaseToken: pkg.leaseToken });
    expect((await taskRow(started.id)).startedAt).not.toBeNull();
    expect((await getPlan(instanceId)).tasks[0]).toMatchObject({ status: "running" });
    // niente da prendere ora → 204
    expect((await api("POST", "/node/claim", { token })).status).toBe(204);
  });

  it("skill node anche dalle specializzate dell'istanza; senza tutte le skill nessun claim", async () => {
    const instanceId = await seedNodeTeam({
      userId,
      roles: [sapRole({ localSkills: ["sap-locale"] })],
      localSkills: [{ code: "sap-locale", kind: "node", content: "sap:cds" }],
    });
    await startTask(instanceId, "t1");
    const partial = await nodeWith(userId, "Parziale", ["sap:abap-developer"]);
    expect((await api("POST", "/node/claim", { token: partial.token })).status).toBe(204);
    const full = await nodeWith(userId, "Completo", ["sap:abap-developer", "sap:cds"]);
    const claim = await api("POST", "/node/claim", { token: full.token });
    expect(claim.status).toBe(200);
    expect(claim.json.nodeSkills).toEqual(["sap:abap-developer", "sap:cds"]);
  });

  it("solo squadre attive dell'utente del nodo, il compito più vecchio prima", async () => {
    const mine = await seedNodeTeam({ userId, roles: [sapRole()], tasks: { t1: "operaio", t2: "operaio" } });
    const others = await seedNodeTeam({ userId: otherUserId, roles: [sapRole()] });
    const draft = await seedNodeTeam({ userId, roles: [sapRole()] });
    const older = await startTask(mine, "t2");
    await startTask(others, "t1");
    const draftTask = await startTask(draft, "t1");
    await db.update(teamInstancesTable).set({ status: "draft" }).where(eq(teamInstancesTable.id, draft));
    const newer = await startTask(mine, "t1");
    await db.update(teamTasksTable).set({ waitingSince: new Date(Date.now() - 60_000) }).where(eq(teamTasksTable.id, older.id));
    await db.update(teamTasksTable).set({ waitingSince: new Date(Date.now() - 120_000) }).where(eq(teamTasksTable.id, draftTask.id));

    const { token } = await nodeWith(userId, "Mac", ["sap:abap-developer"], { maxConcurrent: 3 });
    expect((await api("POST", "/node/claim", { token })).json.taskId).toBe(older.id);
    expect((await api("POST", "/node/claim", { token })).json.taskId).toBe(newer.id);
    expect((await api("POST", "/node/claim", { token })).status).toBe(204);
  });

  it("rispetta max_concurrent del nodo", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()], tasks: { t1: "operaio", t2: "operaio" } });
    await startTask(instanceId, "t1");
    await startTask(instanceId, "t2");
    const { token } = await nodeWith(userId, "Mac", ["sap:abap-developer"], { maxConcurrent: 1 });
    expect((await api("POST", "/node/claim", { token })).status).toBe(200);
    expect((await api("POST", "/node/claim", { token })).status).toBe(204);
  });

  it("due nodi chiedono insieme: il compito va a uno solo", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()] });
    const started = await startTask(instanceId, "t1");
    const a = await nodeWith(userId, "Mac A", ["sap:abap-developer"]);
    const b = await nodeWith(userId, "Mac B", ["sap:abap-developer"]);

    const [ra, rb] = await Promise.all([api("POST", "/node/claim", { token: a.token }), api("POST", "/node/claim", { token: b.token })]);
    expect([ra.status, rb.status].sort()).toEqual([200, 204]);
    const winner = ra.status === 200 ? a : b;
    expect(await taskRow(started.id)).toMatchObject({ status: "running", nodeId: winner.id });
  });

  it("squadra oltre il tetto: nessun claim e nessun evento nuovo", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()], monthlyBudgetUsd: "1.00" });
    await db.insert(teamTasksTable).values({ instanceId, planTaskId: "t0", roleKey: "operaio", instructions: "", status: "done", costUsd: "1.500000" });
    await startTask(instanceId, "t1");
    const { token } = await nodeWith(userId, "Mac", ["sap:abap-developer"]);
    expect((await api("POST", "/node/heartbeat", { token, body: caps(["sap:abap-developer"]) })).json).toEqual({ pending: 0 });
    expect((await api("POST", "/node/claim", { token })).status).toBe(204);
    expect(await events(instanceId)).toHaveLength(0);
  });
});

describe("ping e report", () => {
  async function claimed(over: { maxConcurrent?: number } = {}) {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()] });
    const started = await startTask(instanceId, "t1");
    const node = await nodeWith(userId, "Mac", ["sap:abap-developer"], over);
    const claim = await api("POST", "/node/claim", { token: node.token });
    expect(claim.status, claim.text).toBe(200);
    return { instanceId, taskId: started.id, node, leaseToken: claim.json.leaseToken as string };
  }

  it("ping rinnova la lease; lease sbagliata o scaduta → 409", async () => {
    const { taskId, node, leaseToken } = await claimed();
    await db.update(teamTasksTable).set({ leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(teamTasksTable.id, taskId));
    const ping = await api("POST", `/node/tasks/${taskId}/ping`, { token: node.token, body: { leaseToken } });
    expect(ping.status, ping.text).toBe(200);
    expect(new Date(ping.json.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect((await taskRow(taskId)).leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    const wrong = await api("POST", `/node/tasks/${taskId}/ping`, { token: node.token, body: { leaseToken: "sbagliata" } });
    expect(wrong.status).toBe(409);
    expect(wrong.json).toEqual({ error: LEASE_MSG });
    await db.update(teamTasksTable).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(teamTasksTable.id, taskId));
    expect((await api("POST", `/node/tasks/${taskId}/ping`, { token: node.token, body: { leaseToken } })).status).toBe(409);
  });

  it("il 5° ping nel minuto per lo stesso compito → 429", async () => {
    const { taskId, node, leaseToken } = await claimed();
    for (let i = 0; i < 4; i++) expect((await api("POST", `/node/tasks/${taskId}/ping`, { token: node.token, body: { leaseToken } })).status).toBe(200);
    expect((await api("POST", `/node/tasks/${taskId}/ping`, { token: node.token, body: { leaseToken } })).status).toBe(429);
  });

  it("report chiude il compito: PLAN, evento, turno del capo; costo con ai_model_id null e session_id", async () => {
    const { instanceId, taskId, node, leaseToken } = await claimed();
    const rep = await api("POST", `/node/tasks/${taskId}/report`, {
      token: node.token,
      body: { leaseToken, status: "done", outcome: "Report Z creato", detail: "dettaglio", costUsd: 0.42, promptTokens: 1000, completionTokens: 200, sessionId: "0b7c-uuid" },
    });
    expect(rep.status, rep.text).toBe(204);
    const row = await taskRow(taskId);
    expect(row).toMatchObject({ status: "done", outcome: "Report Z creato", detail: "dettaglio", promptTokens: 1000, completionTokens: 200, sessionId: "0b7c-uuid", aiModelId: null });
    expect(Number(row.costUsd)).toBeCloseTo(0.42);
    expect(row.finishedAt).not.toBeNull();
    expect((await getPlan(instanceId)).tasks[0]).toMatchObject({ status: "done", outcome: "Report Z creato" });
    expect((await events(instanceId)).map((e) => e.type)).toEqual(["compito_finito"]);
    const queued = await turns(instanceId);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reasons).toEqual([{ type: "task_finished", taskId }]);
    expect((await teamSpend(instanceId)).spentUsd).toBeCloseTo(0.42);

    // Un secondo report non cambia nulla
    const again = await api("POST", `/node/tasks/${taskId}/report`, { token: node.token, body: { leaseToken, status: "failed", outcome: "x" } });
    expect(again.status).toBe(409);
    expect((await taskRow(taskId)).status).toBe("done");
    expect((await turns(instanceId))[0]!.reasons).toHaveLength(1);
  });

  it("report blocked → evento bloccato; failed nel PLAN", async () => {
    const { instanceId, taskId, node, leaseToken } = await claimed();
    const rep = await api("POST", `/node/tasks/${taskId}/report`, { token: node.token, body: { leaseToken, status: "failed", outcome: "tempo massimo superato" } });
    expect(rep.status).toBe(204);
    expect((await getPlan(instanceId)).tasks[0]).toMatchObject({ status: "failed", outcome: "tempo massimo superato" });
    expect((await events(instanceId)).map((e) => e.type)).toEqual(["bloccato"]);
  });

  it("report con lease sbagliata, scaduta o da un altro nodo → 409 e nessuna modifica", async () => {
    const { instanceId, taskId, node, leaseToken } = await claimed();
    const body = { leaseToken, status: "done", outcome: "fatto" };
    expect((await api("POST", `/node/tasks/${taskId}/report`, { token: node.token, body: { ...body, leaseToken: "sbagliata" } })).status).toBe(409);
    const intruder = await nodeWith(userId, "Intruso", ["sap:abap-developer"]);
    expect((await api("POST", `/node/tasks/${taskId}/report`, { token: intruder.token, body })).status).toBe(409);
    await db.update(teamTasksTable).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(teamTasksTable.id, taskId));
    const late = await api("POST", `/node/tasks/${taskId}/report`, { token: node.token, body });
    expect(late.status).toBe(409);
    expect(late.json).toEqual({ error: LEASE_MSG });
    expect(await taskRow(taskId)).toMatchObject({ status: "running", outcome: null });
    expect(await events(instanceId)).toHaveLength(0);
    expect(await turns(instanceId)).toHaveLength(0);
    expect((await api("POST", `/node/tasks/999999/report`, { token: node.token, body })).status).toBe(409);
  });

  it("dopo la scadenza della lease e lo sweep il report → 409, nessun secondo turno", async () => {
    const { sweepExpiredLeases } = await import("../lib/nodes/lease-sweeper");
    const { instanceId, taskId, node, leaseToken } = await claimed();
    await db.update(teamTasksTable).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(teamTasksTable.id, taskId));
    expect(await sweepExpiredLeases()).toBe(1);
    expect(await taskRow(taskId)).toMatchObject({ status: "failed", outcome: "nodo non più raggiungibile" });

    const late = await api("POST", `/node/tasks/${taskId}/report`, { token: node.token, body: { leaseToken, status: "done", outcome: "fatto in ritardo" } });
    expect(late.status).toBe(409);
    expect(await taskRow(taskId)).toMatchObject({ status: "failed", outcome: "nodo non più raggiungibile" });
    const queued = await turns(instanceId);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reasons).toEqual([{ type: "task_finished", taskId }]);
    expect((await events(instanceId)).filter((e) => e.type === "bloccato")).toHaveLength(1);
    expect(await db.select().from(teamTasksTable).where(and(eq(teamTasksTable.id, taskId), eq(teamTasksTable.status, "done")))).toHaveLength(0);
  });
});

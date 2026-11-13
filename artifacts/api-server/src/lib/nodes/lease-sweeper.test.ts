import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, nodesTable, teamAttachmentsTable, pool, teamInstancesTable, teamEventsTable, teamTasksTable, teamTurnsTable } from "@workspace/db";
import { catalogSkill, ensureUser, nodeRole, seedNodeTeam } from "../../../test/team-node-fixture";
import { getPlan } from "../teams/plan";
import { failInterruptedTeamWork, startTask } from "../teams/task-runner";
import { createNode } from "./nodes";
import { claimTask, heartbeat } from "./protocol";
import { notifyNodelessTasks, sweepExpiredLeases, sweepNodeTasks } from "./lease-sweeper";

// Scadenza delle lease e avviso «nessun nodo adatto», chiamati con un orologio esplicito.

let userId: number;
const MIN = 60_000;
const caps = (skills: string[]) => ({ version: "0.1.0", executor: "claude-code", skills, workspaceRoot: "/radice", maxConcurrent: 1 });
const sapRole = () => nodeRole({ skills: [{ code: "sap-abap", version: 1 }] });
const taskRow = async (id: number) => (await db.select().from(teamTasksTable).where(eq(teamTasksTable.id, id)))[0]!;
const events = (instanceId: number) => db.select().from(teamEventsTable).where(eq(teamEventsTable.instanceId, instanceId));
const turns = (instanceId: number) => db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId));

afterAll(async () => {
  await pool.query("TRUNCATE users, apps, skills, team_instances RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, skills, team_instances CASCADE");
  userId = await ensureUser("capo@example.com");
  await catalogSkill("sap-abap", "node", "sap:abap-developer");
});

describe("scadenza delle lease", () => {
  it("compito running con lease scaduta → failed «nodo non più raggiungibile», evento bloccato e turno del capo", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()] });
    const started = await startTask(instanceId, "t1");
    const { node } = await createNode(userId, "Mac");
    await heartbeat(node.id, caps(["sap:abap-developer"]));
    const pkg = await claimTask(node.id);
    expect(pkg?.taskId).toBe(started.id);

    // Lease ancora valida: niente
    expect(await sweepExpiredLeases(new Date(Date.now() + 14 * MIN))).toBe(0);
    expect(await sweepExpiredLeases(new Date(Date.now() + 16 * MIN))).toBe(1);
    expect(await taskRow(started.id)).toMatchObject({ status: "failed", outcome: "nodo non più raggiungibile", error: "nodo non più raggiungibile" });
    expect((await getPlan(instanceId)).tasks[0]).toMatchObject({ status: "failed", outcome: "nodo non più raggiungibile" });
    expect((await events(instanceId)).map((e) => e.type)).toEqual(["bloccato"]);
    expect((await turns(instanceId))[0]!.reasons).toEqual([{ type: "task_finished", taskId: started.id }]);
    // Un secondo sweep non trova altro
    expect(await sweepExpiredLeases(new Date(Date.now() + 16 * MIN))).toBe(0);
    expect(await events(instanceId)).toHaveLength(1);
  });

  it("il riavvio dell'API non chiude i compiti presi da un nodo (li gestisce la lease)", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()] });
    const started = await startTask(instanceId, "t1");
    const { node } = await createNode(userId, "Mac");
    await heartbeat(node.id, caps(["sap:abap-developer"]));
    await claimTask(node.id);
    await failInterruptedTeamWork();
    expect((await taskRow(started.id)).status).toBe("running");
  });
});

describe("nessun nodo adatto", () => {
  it("dopo 10 minuti senza nodo vivo con le skill: evento una sola volta, il compito resta in attesa", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()] });
    const started = await startTask(instanceId, "t1");
    // Nodo con le skill giuste ma non vivo; nodo vivo senza le skill
    const { node: stale } = await createNode(userId, "Spento");
    await heartbeat(stale.id, caps(["sap:abap-developer"]));
    await db.update(nodesTable).set({ lastSeenAt: new Date(Date.now() - 5 * MIN) }).where(eq(nodesTable.id, stale.id));
    const { node: wrong } = await createNode(userId, "Senza skill");
    await heartbeat(wrong.id, caps(["altro"]));

    expect(await notifyNodelessTasks(new Date(Date.now() + 9 * MIN))).toBe(0);
    // l'orologio del controllo è esplicito: il nodo "Senza skill" è vivo rispetto a now, non a now+11
    const now = new Date(Date.now() + 11 * MIN);
    await db.update(nodesTable).set({ lastSeenAt: now }).where(eq(nodesTable.id, wrong.id));
    expect(await notifyNodelessTasks(now)).toBe(1);
    expect(await notifyNodelessTasks(now)).toBe(0);
    const evs = await events(instanceId);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "bloccato", taskId: started.id });
    expect(evs[0]!.bulletin).toContain("nessun nodo disponibile con le skill: sap:abap-developer");
    expect(await taskRow(started.id)).toMatchObject({ status: "waiting_node", noNodeNotified: true });
    expect(await turns(instanceId)).toHaveLength(0);
  });

  it("compito con codice e soli nodi 0.3.0: evento con «nessun nodo aggiornato a Botcave Nodo 0.4.0»", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [nodeRole({ skills: [{ code: "sap-abap", version: 1 }], code: "write" })] });
    await startTask(instanceId, "t1");
    const { node } = await createNode(userId, "Vecchio");
    const now = new Date(Date.now() + 11 * MIN);
    await heartbeat(node.id, { ...caps(["sap:abap-developer"]), version: "0.3.0" });
    await db.update(nodesTable).set({ lastSeenAt: now }).where(eq(nodesTable.id, node.id));
    expect(await notifyNodelessTasks(now)).toBe(1);
    const evs = await events(instanceId);
    expect(evs[0]!.bulletin).toContain("nessun nodo aggiornato a Botcave Nodo 0.4.0");
  });

  it("mai se c'è un nodo vivo adatto (anche se occupato)", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()] });
    await startTask(instanceId, "t1");
    const { node } = await createNode(userId, "Mac");
    const now = new Date(Date.now() + 11 * MIN);
    await heartbeat(node.id, caps(["sap:abap-developer"]));
    await db.update(nodesTable).set({ lastSeenAt: now }).where(eq(nodesTable.id, node.id));
    expect(await notifyNodelessTasks(now)).toBe(0);
    expect(await events(instanceId)).toHaveLength(0);
  });

  it("nodi di un altro utente non contano", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()] });
    await startTask(instanceId, "t1");
    const other = await ensureUser("altro@example.com");
    const { node } = await createNode(other, "Mac altrui");
    const now = new Date(Date.now() + 11 * MIN);
    await heartbeat(node.id, caps(["sap:abap-developer"]));
    await db.update(nodesTable).set({ lastSeenAt: now }).where(eq(nodesTable.id, node.id));
    expect(await notifyNodelessTasks(now)).toBe(1);
  });

  it("ruolo non più nella squadra: messaggio fisso sul ruolo, non sulle skill", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()] });
    const started = await startTask(instanceId, "t1");
    const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId));
    await db
      .update(teamInstancesTable)
      .set({ roles: instance!.roles.filter((r) => r.key !== "operaio") })
      .where(eq(teamInstancesTable.id, instanceId));
    expect(await notifyNodelessTasks(new Date(Date.now() + 11 * MIN))).toBe(1);
    const evs = await events(instanceId);
    expect(evs[0]!.bulletin).toBe(`Compito t1 (operaio): ruolo operaio non più nella squadra`);
    expect(evs[0]!.taskId).toBe(started.id);
    expect(evs[0]!.bulletin).not.toContain("skill");
  });

  it("giro periodico: niente avviso nei primi 2 minuti di vita dell'API", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()] });
    await startTask(instanceId, "t1");
    const now = new Date(Date.now() + 11 * MIN);
    await sweepNodeTasks(now, new Date(now.getTime() - 1 * MIN));
    expect(await events(instanceId)).toHaveLength(0);
    await sweepNodeTasks(now, new Date(now.getTime() - 3 * MIN));
    expect((await events(instanceId)).map((e) => e.type)).toEqual(["bloccato"]);
  });
});

describe("pulizia degli allegati eliminati", () => {
  it("sweepNodeTasks ripulisce gli allegati eliminati che nessun compito attivo cita più", async () => {
    const { deleteAttachment, saveAttachment } = await import("../teams/attachments");
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()] });
    const view = await saveAttachment(userId, instanceId, { name: "a.txt", contentType: "text/plain", bytes: Buffer.from("a") });
    const started = await startTask(instanceId, "t1", [view.id]);
    await deleteAttachment(instanceId, view.id);
    const exists = async () => (await db.select().from(teamAttachmentsTable).where(eq(teamAttachmentsTable.id, view.id))).length;
    const now = new Date();
    const upSince = new Date(now.getTime() - 60 * MIN);

    await sweepNodeTasks(now, upSince);
    expect(await exists()).toBe(1);
    await db.update(teamTasksTable).set({ status: "done" }).where(eq(teamTasksTable.id, started.id));
    await sweepNodeTasks(now, upSince);
    expect(await exists()).toBe(0);
  });
});

describe("tetto della squadra nel giro periodico", () => {
  it("squadra oltre il tetto con un nodo vivo (pending: 0): il giro chiude il compito blocked una volta sola", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()], monthlyBudgetUsd: "1.00" });
    await db.insert(teamTasksTable).values({ instanceId, planTaskId: "t0", roleKey: "operaio", instructions: "", status: "done", costUsd: "1.500000" });
    const started = await startTask(instanceId, "t1");
    const { node } = await createNode(userId, "Mac");
    expect(await heartbeat(node.id, caps(["sap:abap-developer"]))).toEqual({ pending: 0 });

    const now = new Date();
    // Anche nei primi minuti di vita dell'API: il tetto non dipende dai nodi
    await sweepNodeTasks(now, now);
    expect(await taskRow(started.id)).toMatchObject({ status: "blocked", outcome: "tetto di spesa della squadra raggiunto", nodeId: null, leaseToken: null });
    expect((await getPlan(instanceId)).tasks.find((t) => t.id === "t1")).toMatchObject({ status: "blocked", outcome: "tetto di spesa della squadra raggiunto" });
    expect((await events(instanceId)).map((e) => [e.type, e.taskId])).toEqual([["bloccato", started.id]]);
    expect((await turns(instanceId)).map((t) => t.reasons)).toEqual([[{ type: "task_finished", taskId: started.id }]]);

    // Un secondo giro non cambia nulla
    await sweepNodeTasks(now, now);
    expect(await events(instanceId)).toHaveLength(1);
    expect((await turns(instanceId))[0]!.reasons).toHaveLength(1);
  });

  it("squadra entro il tetto: il compito resta in attesa", async () => {
    const instanceId = await seedNodeTeam({ userId, roles: [sapRole()], monthlyBudgetUsd: "5.00" });
    const started = await startTask(instanceId, "t1");
    const now = new Date();
    await sweepNodeTasks(now, now);
    expect((await taskRow(started.id)).status).toBe("waiting_node");
    expect(await events(instanceId)).toHaveLength(0);
  });
});

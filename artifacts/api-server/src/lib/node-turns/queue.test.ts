import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, nodeTurnsTable, pool } from "@workspace/db";
import { queueSample, seedNodeTurnSetup, type NodeTurnSetup } from "../../../test/node-turn-fixture";
import { deleteNode, disableNode, regenerateNodeToken } from "../nodes/nodes";
import { claimTurn, reportTurn } from "./protocol";
import { cancelTurn, turnByToken, waitTurn } from "./queue";
import { failInterruptedNodeTurns, sweepNodeTurns } from "./sweeper";

// Coda dei turni delegati al nodo: accodamento, attesa dell'esito, annullamento, scadenze e pulizie (orologio esplicito).

const SEC = 1000;
const DAY = 24 * 3600 * SEC;
let setup: NodeTurnSetup;

const turnRow = async (id: number) => (await db.select().from(nodeTurnsTable).where(eq(nodeTurnsTable.id, id)))[0]!;

afterAll(async () => {
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  await pool.query("TRUNCATE users CASCADE");
  setup = await seedNodeTurnSetup("dev@localhost");
});

describe("enqueueTurn", () => {
  it("riga queued con il pacchetto e solo l'hash del token cat_", async () => {
    const { turnId, turnToken } = await queueSample(setup);
    expect(turnToken).toMatch(/^cat_[A-Za-z0-9_-]{43}$/);
    const row = await turnRow(turnId);
    expect(row).toMatchObject({ status: "queued", nodeId: setup.nodeId, userId: setup.userId, consumer: "character", refId: 1, messageId: 2 });
    expect(row.turnTokenHash).toBe(createHash("sha256").update(turnToken).digest("hex"));
    expect(JSON.stringify(row.package)).not.toContain("cat_");
    expect(row.package).toMatchObject({ model: "sonnet", maxTurns: 7, timeoutMs: 300_000 });
    // Il token vale su /mcp/turn solo quando il turno è preso
    expect(await turnByToken(turnToken)).toBeNull();
  });
});

describe("cancelTurn e waitTurn", () => {
  it("annullare un turno in coda risolve l'attesa con cancelled", async () => {
    const { turnId } = await queueSample(setup);
    const waiting = waitTurn(turnId);
    await cancelTurn(turnId);
    expect(await waiting).toEqual({
      status: "cancelled",
      content: null,
      errorCode: null,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costUsd: null,
    });
    expect(await turnRow(turnId)).toMatchObject({ status: "cancelled", package: null });
    expect((await turnRow(turnId)).finishedAt).not.toBeNull();
  });

  it("un signal annullato chiude il turno cancelled", async () => {
    const { turnId } = await queueSample(setup);
    const ac = new AbortController();
    const waiting = waitTurn(turnId, ac.signal);
    ac.abort();
    expect((await waiting).status).toBe("cancelled");
    expect((await turnRow(turnId)).status).toBe("cancelled");
  });

  it("un turno già chiuso risolve subito con il suo esito", async () => {
    const { turnId } = await queueSample(setup);
    await cancelTurn(turnId);
    expect((await waitTurn(turnId)).status).toBe("cancelled");
  });
});

describe("sweepNodeTurns", () => {
  it("queued da oltre 20 s → expired; prima no", async () => {
    const { turnId } = await queueSample(setup);
    const waiting = waitTurn(turnId);
    await sweepNodeTurns(new Date(Date.now() + 19 * SEC));
    expect((await turnRow(turnId)).status).toBe("queued");
    await sweepNodeTurns(new Date(Date.now() + 21 * SEC));
    expect(await turnRow(turnId)).toMatchObject({ status: "expired", package: null });
    expect((await waiting).status).toBe("expired");
  });

  it("nodo occupato (turno running con lease viva): il turno in coda attende fino a 10 minuti", async () => {
    // Tempo massimo lungo: il turno in corso non chiude per timeout durante la prova
    const busy = await queueSample(setup, { timeoutMs: 3_600_000 });
    expect((await claimTurn(setup.nodeId, 0))?.id).toBe(busy.turnId);
    // Lease rinnovata dai ping per tutta la durata della prova
    await db.update(nodeTurnsTable).set({ leaseExpiresAt: new Date(Date.now() + DAY) }).where(eq(nodeTurnsTable.id, busy.turnId));
    const { turnId } = await queueSample(setup);
    await sweepNodeTurns(new Date(Date.now() + 21 * SEC));
    expect((await turnRow(turnId)).status).toBe("queued");
    await sweepNodeTurns(new Date(Date.now() + 9 * 60 * SEC));
    expect((await turnRow(turnId)).status).toBe("queued");
    await sweepNodeTurns(new Date(Date.now() + 10 * 60 * SEC + SEC));
    expect(await turnRow(turnId)).toMatchObject({ status: "expired", package: null });
    expect((await turnRow(busy.turnId)).status).toBe("running");
  });

  it("un turno running di un altro nodo non tiene in coda quelli di questo nodo", async () => {
    const other = await seedNodeTurnSetup("altro@example.com", "Altro Mac");
    await queueSample(other);
    await claimTurn(other.nodeId, 0);
    const { turnId } = await queueSample(setup);
    await sweepNodeTurns(new Date(Date.now() + 21 * SEC));
    expect((await turnRow(turnId)).status).toBe("expired");
  });

  it("running oltre timeoutMs + 60 s senza report → failed timeout, anche se il nodo rinnova la lease", async () => {
    const { turnId } = await queueSample(setup, { timeoutMs: 300_000 });
    await claimTurn(setup.nodeId, 0);
    await db.update(nodeTurnsTable).set({ leaseExpiresAt: new Date(Date.now() + DAY) }).where(eq(nodeTurnsTable.id, turnId));
    const waiting = waitTurn(turnId);
    await sweepNodeTurns(new Date(Date.now() + 355 * SEC));
    expect((await turnRow(turnId)).status).toBe("running");
    await sweepNodeTurns(new Date(Date.now() + 361 * SEC));
    expect(await turnRow(turnId)).toMatchObject({ status: "failed", errorCode: "timeout", package: null });
    expect(await waiting).toMatchObject({ status: "failed", errorCode: "timeout" });
  });

  it("running con lease scaduta → failed lease_lost", async () => {
    const { turnId } = await queueSample(setup);
    const pkg = await claimTurn(setup.nodeId, 0);
    expect(pkg?.id).toBe(turnId);
    const waiting = waitTurn(turnId);
    await sweepNodeTurns(new Date(Date.now() + 90 * SEC));
    expect((await turnRow(turnId)).status).toBe("running");
    await sweepNodeTurns(new Date(Date.now() + 121 * SEC));
    expect(await turnRow(turnId)).toMatchObject({ status: "failed", errorCode: "lease_lost", package: null });
    expect(await waiting).toMatchObject({ status: "failed", errorCode: "lease_lost" });
  });

  it("cancella le righe chiuse da oltre 30 giorni, non quelle di 29", async () => {
    const old = await queueSample(setup);
    const recent = await queueSample(setup);
    const open = await queueSample(setup);
    await cancelTurn(old.turnId);
    await cancelTurn(recent.turnId);
    const now = Date.now();
    await db.update(nodeTurnsTable).set({ finishedAt: new Date(now - 31 * DAY) }).where(eq(nodeTurnsTable.id, old.turnId));
    await db.update(nodeTurnsTable).set({ finishedAt: new Date(now - 29 * DAY) }).where(eq(nodeTurnsTable.id, recent.turnId));
    await sweepNodeTurns(new Date(now));
    const ids = (await db.select({ id: nodeTurnsTable.id }).from(nodeTurnsTable)).map((r) => r.id).sort((a, b) => a - b);
    expect(ids).toEqual([recent.turnId, open.turnId]);
  });
});

describe("failInterruptedNodeTurns", () => {
  it("queued e running → failed restart; poi il report è rifiutato e il token non vale", async () => {
    const running = await queueSample(setup);
    const pkg = await claimTurn(setup.nodeId, 0);
    expect(pkg?.id).toBe(running.turnId);
    expect(await turnByToken(running.turnToken)).toEqual({ id: running.turnId, userId: setup.userId });
    const queued = await queueSample(setup);
    const done = await queueSample(setup);
    await cancelTurn(done.turnId);

    expect(await failInterruptedNodeTurns()).toBe(2);
    expect(await turnRow(running.turnId)).toMatchObject({ status: "failed", errorCode: "restart", package: null });
    expect(await turnRow(queued.turnId)).toMatchObject({ status: "failed", errorCode: "restart" });
    expect((await turnRow(done.turnId)).status).toBe("cancelled");
    await expect(reportTurn(setup.nodeId, running.turnId, { leaseToken: pkg!.leaseToken, status: "done", content: "tardi" })).rejects.toMatchObject({ status: 409 });
    expect(await turnByToken(running.turnToken)).toBeNull();
  });
});

describe("nodo disattivato, eliminato o con token rigenerato", () => {
  it("disattivare il nodo → turni queued e running failed node_disabled", async () => {
    const running = await queueSample(setup);
    await claimTurn(setup.nodeId, 0);
    const queued = await queueSample(setup);
    const waiting = waitTurn(queued.turnId);
    await disableNode(setup.userId, setup.nodeId);
    expect(await turnRow(running.turnId)).toMatchObject({ status: "failed", errorCode: "node_disabled", package: null });
    expect(await turnRow(queued.turnId)).toMatchObject({ status: "failed", errorCode: "node_disabled" });
    expect(await waiting).toMatchObject({ status: "failed", errorCode: "node_disabled" });
  });

  it("rigenerare il token chiude i turni del nodo", async () => {
    const { turnId } = await queueSample(setup);
    await regenerateNodeToken(setup.userId, setup.nodeId);
    expect(await turnRow(turnId)).toMatchObject({ status: "failed", errorCode: "node_disabled" });
  });

  it("eliminare il nodo chiude i turni prima che node_id diventi null", async () => {
    const { turnId } = await queueSample(setup);
    await deleteNode(setup.userId, setup.nodeId);
    expect(await turnRow(turnId)).toMatchObject({ status: "failed", errorCode: "node_disabled", nodeId: null });
  });
});

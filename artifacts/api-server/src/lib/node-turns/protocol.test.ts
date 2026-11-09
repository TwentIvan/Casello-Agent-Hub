import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, nodesTable, nodeTurnsTable, pool } from "@workspace/db";
import { queueSample, seedNodeTurnSetup, type NodeTurnSetup } from "../../../test/node-turn-fixture";
import { claimTurn, pingTurn, reportTurn } from "./protocol";
import { cancelTurn, turnByToken, waitTurn } from "./queue";

// Protocollo del nodo per i turni: presa con attesa, rinnovo della lease e report.

const SEC = 1000;
let setup: NodeTurnSetup;
let prevUrl: string | undefined;

const turnRow = async (id: number) => (await db.select().from(nodeTurnsTable).where(eq(nodeTurnsTable.id, id)))[0]!;

afterAll(async () => {
  if (prevUrl === undefined) delete process.env["PUBLIC_APP_URL"];
  else process.env["PUBLIC_APP_URL"] = prevUrl;
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  prevUrl ??= process.env["PUBLIC_APP_URL"];
  process.env["PUBLIC_APP_URL"] = "https://botcave.example.com/";
  await pool.query("TRUNCATE users CASCADE");
  setup = await seedNodeTurnSetup("dev@localhost");
});

describe("claimTurn", () => {
  it("prende il turno più vecchio: pacchetto con turnToken cat_, running, lease di 2 minuti, last_turn_poll_at", async () => {
    const first = await queueSample(setup, { prompt: "[utente]\nPrimo" });
    await queueSample(setup, { prompt: "[utente]\nSecondo" });
    const before = Date.now();
    const pkg = await claimTurn(setup.nodeId, 0);
    expect(pkg).toEqual({
      id: first.turnId,
      leaseToken: expect.any(String),
      model: "sonnet",
      systemPrompt: expect.stringContaining("mcp__botcave__"),
      prompt: "[utente]\nPrimo",
      mcpUrl: "https://botcave.example.com/mcp/turn",
      turnToken: first.turnToken,
      maxTurns: 7,
      timeoutMs: 300_000,
    });
    expect(pkg!.turnToken.startsWith("cat_")).toBe(true);
    const row = await turnRow(first.turnId);
    expect(row.status).toBe("running");
    expect(row.leaseToken).toBe(pkg!.leaseToken);
    expect(row.claimedAt).not.toBeNull();
    const lease = row.leaseExpiresAt!.getTime() - before;
    expect(lease).toBeGreaterThanOrEqual(119 * SEC);
    expect(lease).toBeLessThanOrEqual(122 * SEC);
    const [node] = await db.select().from(nodesTable).where(eq(nodesTable.id, setup.nodeId));
    expect(node!.lastTurnPollAt!.getTime()).toBeGreaterThanOrEqual(before - SEC);
    // Il token vale finché il turno è running
    expect(await turnByToken(first.turnToken)).toEqual({ id: first.turnId, userId: setup.userId });
    expect(await turnByToken("cat_sconosciuto")).toBeNull();
  });

  it("senza turni attende e risponde null; un turno accodato durante l'attesa si prende subito", async () => {
    let start = Date.now();
    expect(await claimTurn(setup.nodeId, 200)).toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(190);

    start = Date.now();
    const claiming = claimTurn(setup.nodeId, 5_000);
    await new Promise((r) => setTimeout(r, 50));
    const { turnId } = await queueSample(setup);
    expect((await claiming)?.id).toBe(turnId);
    expect(Date.now() - start).toBeLessThan(4_000);
  });

  it("un signal annullato interrompe l'attesa", async () => {
    const ac = new AbortController();
    const start = Date.now();
    const claiming = claimTurn(setup.nodeId, 5_000, ac.signal);
    setTimeout(() => ac.abort(), 50);
    expect(await claiming).toBeNull();
    expect(Date.now() - start).toBeLessThan(2_000);
    // Il turno accodato dopo resta per la presa successiva
    const { turnId } = await queueSample(setup);
    expect((await turnRow(turnId)).status).toBe("queued");
  });

  it("il turno di un altro nodo non si prende", async () => {
    const other = await seedNodeTurnSetup("altro@example.com", "Altro Mac");
    await queueSample(other);
    expect(await claimTurn(setup.nodeId, 0)).toBeNull();
  });

  it("nodo disattivato → 403", async () => {
    await db.update(nodesTable).set({ status: "disabled" }).where(eq(nodesTable.id, setup.nodeId));
    await expect(claimTurn(setup.nodeId, 0)).rejects.toMatchObject({ status: 403 });
  });
});

describe("pingTurn", () => {
  it("rinnova la lease; turno annullato o lease sbagliata → 409", async () => {
    const { turnId } = await queueSample(setup);
    const pkg = (await claimTurn(setup.nodeId, 0))!;
    const renewed = await pingTurn(setup.nodeId, turnId, pkg.leaseToken);
    expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now() + 110 * SEC);
    await expect(pingTurn(setup.nodeId, turnId, "sbagliata")).rejects.toMatchObject({ status: 409, message: "lease non valida o scaduta" });
    await cancelTurn(turnId);
    await expect(pingTurn(setup.nodeId, turnId, pkg.leaseToken)).rejects.toMatchObject({ status: 409 });
  });
});

describe("reportTurn", () => {
  it("done: l'attesa risolve con contenuto, token e costo; il pacchetto si svuota; un secondo report → 409", async () => {
    const { turnId, turnToken } = await queueSample(setup);
    const waiting = waitTurn(turnId);
    const pkg = (await claimTurn(setup.nodeId, 0))!;
    await expect(reportTurn(setup.nodeId, turnId, { leaseToken: "sbagliata", status: "done", content: "x" })).rejects.toMatchObject({ status: 409 });
    await reportTurn(setup.nodeId, turnId, {
      leaseToken: pkg.leaseToken,
      status: "done",
      content: "Risposta di Claude",
      promptTokens: 1200,
      completionTokens: 300,
      cachedTokens: 800,
      costUsd: 0.0123,
      sessionId: "sess-1",
    });
    expect(await waiting).toEqual({
      status: "done",
      content: "Risposta di Claude",
      errorCode: null,
      promptTokens: 1200,
      completionTokens: 300,
      cachedTokens: 800,
      costUsd: "0.012300",
    });
    expect(await turnRow(turnId)).toMatchObject({ status: "done", package: null, sessionId: "sess-1" });
    expect(await turnByToken(turnToken)).toBeNull();
    await expect(reportTurn(setup.nodeId, turnId, { leaseToken: pkg.leaseToken, status: "done", content: "di nuovo" })).rejects.toMatchObject({ status: 409 });
  });

  it("failed con errorCode sconosciuto → claude_failed; contenuto troncato a 20 000", async () => {
    const a = await queueSample(setup);
    const pkgA = (await claimTurn(setup.nodeId, 0))!;
    await reportTurn(setup.nodeId, a.turnId, { leaseToken: pkgA.leaseToken, status: "failed", errorCode: "boh" });
    expect(await turnRow(a.turnId)).toMatchObject({ status: "failed", errorCode: "claude_failed" });

    const b = await queueSample(setup);
    const pkgB = (await claimTurn(setup.nodeId, 0))!;
    await reportTurn(setup.nodeId, b.turnId, { leaseToken: pkgB.leaseToken, status: "failed", errorCode: "usage_limit", content: "x".repeat(25_000) });
    const row = await turnRow(b.turnId);
    expect(row).toMatchObject({ status: "failed", errorCode: "usage_limit" });
    expect(row.content).toHaveLength(20_000);
  });

  it("il turno di un altro nodo → 409", async () => {
    const other = await seedNodeTurnSetup("altro@example.com", "Altro Mac");
    const { turnId } = await queueSample(other);
    const pkg = (await claimTurn(other.nodeId, 0))!;
    await expect(reportTurn(setup.nodeId, turnId, { leaseToken: pkg.leaseToken, status: "done", content: "x" })).rejects.toMatchObject({ status: 409 });
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiAccountsTable, aiModelsTable, db, nodesTable, nodeTurnsTable, pool } from "@workspace/db";
import { seedNodeTurnSetup, type NodeTurnSetup } from "../../../test/node-turn-fixture";
import { resolveModel, type ResolvedModel } from "../ai/executor";
import type { ChatToolCall } from "../ai/chat-types";
import { NODE_TURN_MESSAGES } from "./messages";
import { claimTurn, reportTurn, type TurnPackage } from "./protocol";
import { delegateTurn, type DelegateInput } from "./delegate";
import { TOOLS_LINE } from "./prompt";
import { turnEntry } from "./registry";
import { sweepNodeTurns } from "./sweeper";

// delegateTurn con un «nodo finto»: il test prende il turno con claimTurn, chiama gli strumenti come /mcp/turn
// (voce del registro) e riferisce con reportTurn.

const SEC = 1000;
let setup: NodeTurnSetup;
let resolved: ResolvedModel;
let dispatched: ChatToolCall[];

const TOOL = { type: "function" as const, function: { name: "leggi_prova", description: "Legge", parameters: { type: "object", properties: {} } } };

const turnRows = () => db.select().from(nodeTurnsTable);
const modelAvailability = async () => (await db.select().from(aiModelsTable).where(eq(aiModelsTable.id, setup.aiModelId)))[0]!.availability;
const markNodeReady = () => db.update(nodesTable).set({ lastTurnPollAt: new Date() }).where(eq(nodesTable.id, setup.nodeId));

function input(over: Partial<DelegateInput> = {}): DelegateInput {
  return {
    resolved,
    userId: setup.userId,
    consumer: "character",
    refId: 10,
    messageId: 20,
    messages: [
      { role: "system", content: "Sei Lucius." },
      { role: "user", content: "Ciao" },
    ],
    tools: [TOOL],
    dispatch: async (call) => {
      dispatched.push(call);
      return JSON.stringify({ ok: true, result: "letto" });
    },
    maxTurns: 7,
    timeoutMs: 300_000,
    ...over,
  };
}

/** Il nodo finto prende il turno appena accodato. */
async function claim(): Promise<TurnPackage> {
  const pkg = await claimTurn(setup.nodeId, 5 * SEC);
  if (!pkg) throw new Error("nessun turno preso");
  return pkg;
}

afterAll(async () => {
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users CASCADE");
  setup = await seedNodeTurnSetup("dev@localhost", "Mac di Ivan");
  resolved = await resolveModel(setup.aiModelId, { userId: setup.userId, mustOwn: true });
  dispatched = [];
});

describe("delegateTurn", () => {
  it("nodo pronto: pacchetto con modello e prompt, strumento via registro, done con contenuto e costo; modello available; registro tolto", async () => {
    await markNodeReady();
    const outcome = delegateTurn(input());
    const pkg = await claim();
    expect(pkg).toMatchObject({ model: "sonnet", maxTurns: 7, timeoutMs: 300_000, prompt: "[utente]\nCiao" });
    expect(pkg.systemPrompt).toBe(`Sei Lucius.\n${TOOLS_LINE}`);
    const entry = turnEntry(pkg.id)!;
    expect(entry.maxCalls).toBe(28);
    expect(entry.tools.map((t) => t.function.name)).toEqual(["leggi_prova"]);
    expect(await entry.dispatch({ id: "c1", name: "leggi_prova", arguments: "{}" })).toBe(JSON.stringify({ ok: true, result: "letto" }));
    await reportTurn(setup.nodeId, pkg.id, {
      leaseToken: pkg.leaseToken,
      status: "done",
      content: "Fatto.",
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: 30,
      costUsd: 0.0123,
    });
    expect(await outcome).toEqual({
      kind: "done",
      content: "Fatto.",
      tokens: 120,
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: 30,
      costUsd: "0.012300",
    });
    expect(dispatched).toHaveLength(1);
    expect(turnEntry(pkg.id)).toBeUndefined();
    expect(await modelAvailability()).toBe("available");
    const [row] = await turnRows();
    expect(row).toMatchObject({ consumer: "character", refId: 10, messageId: 20, aiModelId: setup.aiModelId, userId: setup.userId });
  });

  it("nodo mai collegato → fallback offline senza righe in node_turns", async () => {
    const outcome = await delegateTurn(input());
    expect(outcome).toEqual({ kind: "fallback", reason: "offline", message: NODE_TURN_MESSAGES.offline("Mac di Ivan") });
    expect(await turnRows()).toHaveLength(0);
  });

  it("nodo disattivato → fallback offline; account senza nodo → fallback node_deleted", async () => {
    await db.update(nodesTable).set({ status: "disabled", lastTurnPollAt: new Date() }).where(eq(nodesTable.id, setup.nodeId));
    expect(await delegateTurn(input())).toMatchObject({ kind: "fallback", reason: "offline" });
    await db.update(aiAccountsTable).set({ nodeId: null }).where(eq(aiAccountsTable.nodeId, setup.nodeId));
    const orphan = await resolveModel(setup.aiModelId, { userId: setup.userId, mustOwn: true });
    expect(await delegateTurn(input({ resolved: orphan }))).toEqual({
      kind: "fallback",
      reason: "node_deleted",
      message: NODE_TURN_MESSAGES.nodeDeleted,
    });
    expect(await turnRows()).toHaveLength(0);
  });

  it("nessuna presa entro 20 s → fallback expired (sweeper con orologio iniettato); registro tolto", async () => {
    await markNodeReady();
    const outcome = delegateTurn(input());
    let turnId: number | undefined;
    for (let i = 0; i < 100 && turnId === undefined; i++) {
      turnId = (await turnRows())[0]?.id;
      if (turnId === undefined) await new Promise((r) => setTimeout(r, 10));
    }
    expect(turnEntry(turnId!)).toBeDefined();
    await sweepNodeTurns(new Date(Date.now() + 21 * SEC));
    expect(await outcome).toEqual({ kind: "fallback", reason: "expired", message: NODE_TURN_MESSAGES.offline("Mac di Ivan") });
    expect(turnEntry(turnId!)).toBeUndefined();
  });

  it("report usage_limit → fallback usage_limit", async () => {
    await markNodeReady();
    const outcome = delegateTurn(input());
    const pkg = await claim();
    await reportTurn(setup.nodeId, pkg.id, { leaseToken: pkg.leaseToken, status: "failed", errorCode: "usage_limit" });
    expect(await outcome).toEqual({ kind: "fallback", reason: "usage_limit", message: NODE_TURN_MESSAGES.usageLimit });
    expect(turnEntry(pkg.id)).toBeUndefined();
  });

  it("report timeout dopo una tool call → failed «Claude Code non ha risposto in tempo», nessun ripiego", async () => {
    await markNodeReady();
    const outcome = delegateTurn(input());
    const pkg = await claim();
    await turnEntry(pkg.id)!.dispatch({ id: "c1", name: "leggi_prova", arguments: "{}" });
    await reportTurn(setup.nodeId, pkg.id, { leaseToken: pkg.leaseToken, status: "failed", errorCode: "timeout", promptTokens: 50, completionTokens: 10, costUsd: 0.5 });
    expect(await outcome).toEqual({
      kind: "failed",
      error: "Claude Code non ha risposto in tempo",
      tokens: 60,
      promptTokens: 50,
      completionTokens: 10,
      cachedTokens: 0,
      costUsd: "0.500000",
    });
    expect(dispatched).toHaveLength(1);
    expect(turnEntry(pkg.id)).toBeUndefined();
  });

  it("report model_unavailable → failed e modello unavailable", async () => {
    await markNodeReady();
    const outcome = delegateTurn(input());
    const pkg = await claim();
    await reportTurn(setup.nodeId, pkg.id, { leaseToken: pkg.leaseToken, status: "failed", errorCode: "model_unavailable" });
    expect(await outcome).toMatchObject({ kind: "failed", error: NODE_TURN_MESSAGES.modelUnavailable });
    expect(await modelAvailability()).toBe("unavailable");
  });

  it("signal annullato → turno cancelled e kind cancelled; registro tolto", async () => {
    await markNodeReady();
    const ac = new AbortController();
    const outcome = delegateTurn(input({ signal: ac.signal }));
    const pkg = await claim();
    ac.abort();
    expect(await outcome).toEqual({ kind: "cancelled" });
    const [row] = await turnRows();
    expect(row!.status).toBe("cancelled");
    expect(turnEntry(pkg.id)).toBeUndefined();
  });

  it("signal già annullato → cancelled senza accodare", async () => {
    await markNodeReady();
    const ac = new AbortController();
    ac.abort();
    expect(await delegateTurn(input({ signal: ac.signal }))).toEqual({ kind: "cancelled" });
    expect(await turnRows()).toHaveLength(0);
  });

  it("dispatcher dopo la chiusura del turno: non chiama lo strumento", async () => {
    await markNodeReady();
    const outcome = delegateTurn(input());
    const pkg = await claim();
    const entry = turnEntry(pkg.id)!;
    await reportTurn(setup.nodeId, pkg.id, { leaseToken: pkg.leaseToken, status: "done", content: "ok" });
    await outcome;
    const text = await entry.dispatch({ id: "c2", name: "leggi_prova", arguments: "{}" });
    expect(JSON.parse(text)).toMatchObject({ ok: false });
    expect(dispatched).toHaveLength(0);
  });
});

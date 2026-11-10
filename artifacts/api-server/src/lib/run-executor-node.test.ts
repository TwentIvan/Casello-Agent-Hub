import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  agentToolsTable,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  appToolsTable,
  nodesTable,
  nodeTurnsTable,
  pendingActionsTable,
  runsTable,
  runStepsTable,
  type InsertAppTool,
} from "@workspace/db";
import { seedNodeTurnSetup, type NodeTurnSetup } from "../../test/node-turn-fixture";
import { allowTestLoopback } from "../../test/fake-provider";
import { encryptSecret } from "./secrets";
import { NODE_TURN_MESSAGES } from "./node-turns/messages";
import { claimTurn, reportTurn, type TurnPackage } from "./node-turns/protocol";
import { turnEntry } from "./node-turns/registry";
import { cancelRun, startRun } from "./run-executor";

// Run degli agenti delegate al nodo (spec §5 «Run degli agenti», §6): il test fa da nodo finto, prende il turno con
// claimTurn, chiama gli strumenti come /mcp/turn (voce del registro) e riferisce con reportTurn.

const SEC = 1000;
let setup: NodeTurnSetup;
let appRequests: { method: string; url: string }[];
let llmRequests: any[];
let llmReplies: unknown[];
let appServer: http.Server;
let llm: http.Server;
let appBase: string;
let llmBase: string;
let savedKey: string | undefined;
let restoreLoopback: () => void;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

beforeAll(() => {
  restoreLoopback = allowTestLoopback();
});
afterAll(async () => {
  restoreLoopback();
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  savedKey = process.env["CASELLO_SECRET_KEY"];
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  appRequests = [];
  llmRequests = [];
  llmReplies = [];
  appServer = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      appRequests.push({ method: req.method ?? "", url: req.url ?? "" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: 42, name: "Rosa" }));
    });
  });
  llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      llmRequests.push(JSON.parse(raw));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(llmReplies.shift() ?? { choices: [{ message: { role: "assistant", content: "Fatto col ripiego." } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  appBase = `http://127.0.0.1:${await listen(appServer)}/api`;
  llmBase = `http://127.0.0.1:${await listen(llm)}/v1`;
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  setup = await seedNodeTurnSetup("dev@localhost", "Mac di Ivan");
});

afterEach(async () => {
  vi.restoreAllMocks();
  appServer.closeAllConnections();
  llm.closeAllConnections();
  await new Promise((r) => appServer.close(r));
  await new Promise((r) => llm.close(r));
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
});

const GET_ITEM: Partial<InsertAppTool> = {
  name: "get_item",
  description: "Legge un elemento",
  kind: "http",
  identity: "service",
  level: "L0",
  status: "active",
  paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  definition: { method: "GET", path: "/items/{id}", paramLocations: { id: "path" } },
};
const DELETE_ITEM: Partial<InsertAppTool> = {
  name: "delete_item",
  description: "Elimina un elemento",
  kind: "http",
  identity: "service",
  level: "L2",
  status: "active",
  paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  definition: { method: "DELETE", path: "/items/{id}", paramLocations: { id: "path" } },
};
const POST_ITEM: Partial<InsertAppTool> = {
  name: "post_item",
  description: "Crea un elemento",
  kind: "http",
  identity: "service",
  level: "L1",
  status: "active",
  paramsSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  definition: { method: "POST", path: "/items", paramLocations: { name: "body" } },
};

async function seedRun(tools: Partial<InsertAppTool>[], agent: Partial<typeof agentsTable.$inferInsert> = {}): Promise<number> {
  const [a] = await db
    .insert(appsTable)
    .values({
      name: "Mister",
      slug: "mister",
      baseUrl: "http://mister.example",
      internalBaseUrl: appBase,
      serviceAuth: { header: "authorization", scheme: "Bearer" },
      serviceSecretEnc: encryptSecret("srv-secret"),
    })
    .returning();
  const [ag] = await db
    .insert(agentsTable)
    .values({ appId: a!.id, name: "Generale", role: "general", status: "active", aiModelId: setup.aiModelId, systemPrompt: "Aiuta.", ...agent })
    .returning();
  const rows = await db.insert(appToolsTable).values(tools.map((t) => ({ appId: a!.id, ...t }) as InsertAppTool)).returning();
  if (ag!.role === "area") await db.insert(agentToolsTable).values(rows.map((t) => ({ agentId: ag!.id, toolId: t.id })));
  const [run] = await db.insert(runsTable).values({ agentId: ag!.id, input: "Fai il lavoro", aiModelId: setup.aiModelId }).returning();
  return run!.id;
}

const markNodeReady = () => db.update(nodesTable).set({ lastTurnPollAt: new Date() }).where(eq(nodesTable.id, setup.nodeId));
const getRun = async (id: number) => (await db.select().from(runsTable).where(eq(runsTable.id, id)))[0]!;
const getSteps = (id: number) => db.select().from(runStepsTable).where(eq(runStepsTable.runId, id)).orderBy(runStepsTable.position);

async function claim(): Promise<TurnPackage> {
  const pkg = await claimTurn(setup.nodeId, 5 * SEC);
  if (!pkg) throw new Error("nessun turno preso");
  return pkg;
}

/** Modello cloud dello stesso utente, impostato come ripiego dell'account nodo. */
async function seedFallback(): Promise<number> {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: setup.userId, name: "Cloud", provider: "custom", baseUrl: llmBase, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "modello-cloud", displayName: "Cloud base" }).returning();
  await db.update(aiAccountsTable).set({ fallbackAiModelId: model!.id }).where(eq(aiAccountsTable.nodeId, setup.nodeId));
  return model!.id;
}

describe("run delegate al nodo", () => {
  it("L0 eseguita, L2 accodata, done: succeeded con output, passi tool/queued/model con la nota, totali riferiti", async () => {
    await markNodeReady();
    const id = await seedRun([GET_ITEM, DELETE_ITEM]);
    const running = startRun(id);
    const pkg = await claim();
    expect(pkg).toMatchObject({ model: "sonnet", maxTurns: 13, timeoutMs: 600_000 });
    expect(pkg.systemPrompt).toContain("Aiuta.");
    expect(pkg.prompt).toContain("Fai il lavoro");
    const entry = turnEntry(pkg.id)!;
    expect(entry.tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(["get_item", "delete_item", "proponi"]));
    expect(JSON.parse(await entry.dispatch({ id: "c1", name: "get_item", arguments: JSON.stringify({ id: "42" }) }))).toEqual({ id: 42, name: "Rosa" });
    const queuedText = await entry.dispatch({ id: "c2", name: "delete_item", arguments: JSON.stringify({ id: "7", destinatario: "Rosa", sintesi: "Elimina 7" }) });
    expect(queuedText).toBe("accodata come n. 1, in attesa di conferma dell'utente");
    await reportTurn(setup.nodeId, pkg.id, {
      leaseToken: pkg.leaseToken,
      status: "done",
      content: "Letto 42, eliminazione in coda.",
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: 30,
      costUsd: 0.0123,
    });
    await running;

    const run = await getRun(id);
    expect(run).toMatchObject({
      status: "succeeded",
      output: "Letto 42, eliminazione in coda.",
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: 30,
      costUsd: "0.012300",
      aiModelId: setup.aiModelId,
    });
    expect(appRequests).toEqual([{ method: "GET", url: "/api/items/42" }]);
    const steps = await getSteps(id);
    expect(steps.map((s) => [s.type, s.toolName, s.ok])).toEqual([
      ["tool", "get_item", true],
      ["queued", "delete_item", true],
      ["model", null, true],
    ]);
    expect(steps[1]!.args).toMatchObject({ numero: 1, destinatario: "Rosa", sintesi: "Elimina 7" });
    expect(steps[2]!.note).toBe("Claude Code sul nodo «Mac di Ivan»");
    const [action] = await db.select().from(pendingActionsTable);
    expect(action).toMatchObject({ number: 1, status: "pending", runId: id, userId: setup.userId });
    const [turn] = await db.select().from(nodeTurnsTable);
    expect(turn).toMatchObject({ consumer: "run", refId: id, status: "done" });
  });

  it("agente di area con conferma delle scritture: la L1 finisce in coda; maxTurns 9 e timeout 300 s", async () => {
    await markNodeReady();
    const id = await seedRun([POST_ITEM], { role: "area", confirmWrites: true });
    const running = startRun(id);
    const pkg = await claim();
    expect(pkg).toMatchObject({ maxTurns: 9, timeoutMs: 300_000 });
    const text = await turnEntry(pkg.id)!.dispatch({ id: "c1", name: "post_item", arguments: JSON.stringify({ name: "x", destinatario: "Rosa", sintesi: "Crea x" }) });
    expect(text).toContain("accodata come n. 1");
    await reportTurn(setup.nodeId, pkg.id, { leaseToken: pkg.leaseToken, status: "done", content: "In coda." });
    await running;
    expect(appRequests).toHaveLength(0);
    expect(await db.select().from(pendingActionsTable)).toHaveLength(1);
    expect((await getRun(id)).status).toBe("succeeded");
  });

  it("report failed: run failed col messaggio fisso e passo model fallito con la nota", async () => {
    await markNodeReady();
    const id = await seedRun([GET_ITEM]);
    const running = startRun(id);
    const pkg = await claim();
    await reportTurn(setup.nodeId, pkg.id, { leaseToken: pkg.leaseToken, status: "failed", errorCode: "timeout", promptTokens: 50, completionTokens: 10, costUsd: 0.5 });
    await running;
    const run = await getRun(id);
    expect(run).toMatchObject({ status: "failed", errorMessage: NODE_TURN_MESSAGES.timeout, promptTokens: 50, completionTokens: 10, costUsd: "0.500000" });
    const steps = await getSteps(id);
    expect(steps.map((s) => [s.type, s.ok, s.error, s.note])).toEqual([["model", false, NODE_TURN_MESSAGES.timeout, "Claude Code sul nodo «Mac di Ivan»"]]);
  });

  it("cancelRun durante il turno: run cancelled, turno cancelled, report successivo 409, nessuna riscrittura", async () => {
    await markNodeReady();
    const id = await seedRun([GET_ITEM]);
    const running = startRun(id);
    const pkg = await claim();
    expect((await cancelRun(id)).kind).toBe("cancelled");
    await running;
    const [turn] = await db.select().from(nodeTurnsTable);
    expect(turn!.status).toBe("cancelled");
    await expect(
      reportTurn(setup.nodeId, pkg.id, { leaseToken: pkg.leaseToken, status: "done", content: "tardi" }),
    ).rejects.toMatchObject({ status: 409 });
    const run = await getRun(id);
    expect(run).toMatchObject({ status: "cancelled", output: null });
    expect(run.durationMs).not.toBeNull();
    expect(await getSteps(id)).toHaveLength(0);
  });

  it("nodo offline con ripiego: ciclo cloud sul ripiego, passo «Claude Code non disponibile», ai_model_id = ripiego", async () => {
    const fallbackId = await seedFallback();
    const id = await seedRun([GET_ITEM]);
    await startRun(id);
    const run = await getRun(id);
    expect(run).toMatchObject({ status: "succeeded", output: "Fatto col ripiego.", aiModelId: fallbackId, promptTokens: 10, completionTokens: 5 });
    expect(llmRequests).toHaveLength(1);
    expect(llmRequests[0].model).toBe("modello-cloud");
    const steps = await getSteps(id);
    expect(steps.map((s) => [s.type, s.ok, s.note])).toEqual([
      ["model", true, "Claude Code non disponibile: eseguita con Cloud base"],
      ["model", true, null],
    ]);
    expect(await db.select().from(nodeTurnsTable)).toHaveLength(0);
  });

  it("nodo offline senza ripiego: run failed col messaggio offline", async () => {
    const id = await seedRun([GET_ITEM]);
    await startRun(id);
    const run = await getRun(id);
    expect(run).toMatchObject({ status: "failed", errorMessage: "Il nodo «Mac di Ivan» è offline: accendilo o scegli un altro modello" });
    expect(llmRequests).toHaveLength(0);
  });

  it("ripiego col tetto raggiunto: non si usa, run failed col messaggio del nodo", async () => {
    const fallbackId = await seedFallback();
    await db.update(aiModelsTable).set({ monthlyBudgetUsd: "0" }).where(eq(aiModelsTable.id, fallbackId));
    const id = await seedRun([GET_ITEM]);
    await startRun(id);
    expect(await getRun(id)).toMatchObject({ status: "failed", errorMessage: NODE_TURN_MESSAGES.offline("Mac di Ivan"), aiModelId: setup.aiModelId });
    expect(llmRequests).toHaveLength(0);
  });
});

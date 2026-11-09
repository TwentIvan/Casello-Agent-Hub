import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  aiModelsTable,
  appsTable,
  appToolsTable,
  characterMessagesTable,
  characterProposalsTable,
  nodesTable,
  nodeTurnsTable,
  pendingActionsTable,
  runStepsTable,
  usersTable,
  type InsertAppTool,
} from "@workspace/db";
import { CaselloClient } from "../../casello-nodo/src/client";
import type { Config } from "../../casello-nodo/src/config";
import type { Logger } from "../../casello-nodo/src/log";
import { startTurnLoop, type TurnLoop } from "../../casello-nodo/src/turns";
import { encryptSecret } from "../src/lib/secrets";
import { logger as apiLogger } from "../src/lib/logger";
import { seedNodeTurnSetup, type NodeTurnSetup } from "./node-turn-fixture";

// Prova di flusso dei turni delegati (spec §11 «Flusso»): API vera in memoria (PGlite) su una porta locale e il ciclo
// dei turni VERO di casello-nodo, con `claudeBin` = fake-claude.mjs che si collega davvero a /mcp/turn con il client MCP.
// Il caso con il `claude` vero (modello haiku, account del Mac) parte solo con CASELLO_REAL_CLAUDE=1.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL", "FAKE_CLAUDE_PLAN", "FAKE_CLAUDE_RECORD"];
const saved: Record<string, string | undefined> = {};
const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const REAL_CLAUDE = process.env["CASELLO_REAL_CLAUDE"] === "1";

let base: string;
let server: http.Server;
let stopRunQueue: () => void;
let setup: NodeTurnSetup;
let tmp: string;
let loop: TurnLoop | null = null;
let nodeLog: string[];
let turnToolCalls: string[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/api${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`attesa scaduta: ${what}`);
}

/** Avvia il ciclo dei turni di casello-nodo e attende che il nodo risulti pronto (un claim in corso). */
async function startNode(claudeBin: string): Promise<void> {
  const collect = (level: string) => (m: string) => nodeLog.push(`${level} ${m}`);
  const logger: Logger = { info: collect("info"), warn: collect("warn"), error: collect("error") };
  const config: Config = {
    caselloUrl: base,
    token: setup.nodeToken,
    workspaceRoot: tmp,
    claudeBin,
    permissionMode: "bypassPermissions",
    skillsDirs: [],
    maxConcurrent: 1,
    maxConcurrentTurns: 2,
    taskTimeoutMinutes: 60,
  };
  const client = new CaselloClient({ baseUrl: base, token: setup.nodeToken });
  loop = startTurnLoop({ config, client, logger, turnsDir: path.join(tmp, "turns"), errorWaitMs: 200 });
  await until("nodo pronto per i turni", async () => {
    const [n] = await db.select({ at: nodesTable.lastTurnPollAt }).from(nodesTable).where(eq(nodesTable.id, setup.nodeId));
    return n?.at ?? null;
  });
}

async function readRecord(): Promise<{
  args: string[];
  stdin: string;
  mcpType: string;
  mcpUrl: string;
  bearerIsTurnToken: boolean;
  tools: string[];
  callIsError: boolean;
  callText: string | null;
}> {
  return JSON.parse(await readFile(process.env["FAKE_CLAUDE_RECORD"]!, "utf8"));
}

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

async function seedApp(tools: Partial<InsertAppTool>[], agent: Partial<typeof agentsTable.$inferInsert> = {}) {
  const [app] = await db
    .insert(appsTable)
    .values({
      name: "Mister",
      slug: "mister",
      baseUrl: "http://mister.example",
      serviceAuth: { header: "authorization", scheme: "Bearer" },
      serviceSecretEnc: encryptSecret("srv-secret"),
    })
    .returning();
  const [ag] = await db
    .insert(agentsTable)
    .values({ appId: app!.id, name: "Generale", role: "general", status: "active", aiModelId: setup.aiModelId, systemPrompt: "Aiuta.", ...agent })
    .returning();
  if (tools.length > 0) await db.insert(appToolsTable).values(tools.map((t) => ({ appId: app!.id, ...t }) as InsertAppTool));
  return { appId: app!.id, agentId: ag!.id };
}

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

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: "dev@localhost", CASELLO_SECRET_KEY: "f".repeat(64) });
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { default: app } = await import("../src/app");
  const { startRunQueue } = await import("../src/lib/run-queue");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Il pacchetto del turno porta `<PUBLIC_APP_URL>/mcp/turn`: il finto (o claude) ci si collega davvero
  process.env["PUBLIC_APP_URL"] = base;
  stopRunQueue = startRunQueue();
});

afterAll(async () => {
  stopRunQueue();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users CASCADE");
  setup = await seedNodeTurnSetup("dev@localhost", "Mac di Ivan");
  tmp = await mkdtemp(path.join(tmpdir(), "casello-flusso-"));
  process.env["FAKE_CLAUDE_RECORD"] = path.join(tmp, "record.json");
  nodeLog = [];
  turnToolCalls = [];
  // /mcp/turn registra nome dello strumento ed esito (mai argomenti né token): basta per sapere cosa ha chiamato Claude
  const original = apiLogger.info.bind(apiLogger);
  vi.spyOn(apiLogger, "info").mockImplementation(((obj: unknown, ...rest: unknown[]) => {
    if (obj && typeof obj === "object" && "tool" in obj && rest[0] === "Strumento del turno chiamato") {
      turnToolCalls.push((obj as { tool: string }).tool);
    }
    return (original as (...a: unknown[]) => void)(obj, ...rest);
  }) as typeof apiLogger.info);
});

afterEach(async () => {
  await loop?.stop();
  loop = null;
  vi.mocked(apiLogger.info).mockRestore();
  await rm(tmp, { recursive: true, force: true });
  // Il token del turno non compare mai nel log del nodo
  expect(nodeLog.join("\n")).not.toMatch(/cat_[A-Za-z0-9_-]{8,}/);
});

describe("turni delegati al nodo: flusso completo con il ciclo di casello-nodo", () => {
  it("Lucius sull'agente: claude finto chiama proponi_prompt_agente su /mcp/turn → scheda agent_prompt e risposta salvata", async () => {
    const { agentId } = await seedApp([]);
    await db.update(usersTable).set({ luciusAiModelId: setup.aiModelId }).where(eq(usersTable.id, setup.userId));
    process.env["FAKE_CLAUDE_PLAN"] = JSON.stringify({
      tool: "proponi_prompt_agente",
      arguments: { systemPrompt: "Aiuta i clienti di Mister con precisione.", motivazione: "Prompt più chiaro." },
      result: "Ti ho proposto un prompt nuovo: lo trovi nella scheda.",
    });
    await startNode(FAKE_CLAUDE);

    const conv = await api("POST", "/character-conversations", { character: "lucius", subjectType: "agent", subjectId: String(agentId) });
    expect(conv.status, conv.text).toBe(201);
    const sent = await api("POST", `/character-conversations/${conv.json.id}/messages`, { content: "Migliora il prompt dell'agente" });
    expect(sent.status, sent.text).toBe(202);
    await until("turno di Lucius chiuso", async () => {
      const r = await api("GET", `/character-conversations/${conv.json.id}`);
      return r.json?.turnStatus === "idle" ? r.json : null;
    });

    const proposals = await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.conversationId, conv.json.id));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: "agent_prompt", status: "pending", payload: { systemPrompt: "Aiuta i clienti di Mister con precisione." } });
    const messages = await db.select().from(characterMessagesTable).where(eq(characterMessagesTable.conversationId, conv.json.id)).orderBy(characterMessagesTable.id);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", error: false, content: "Ti ho proposto un prompt nuovo: lo trovi nella scheda." });

    const rec = await readRecord();
    expect(rec).toMatchObject({ mcpType: "http", mcpUrl: `${base}/mcp/turn`, bearerIsTurnToken: true, callIsError: false });
    expect(rec.tools).toEqual(expect.arrayContaining(["leggi_agente", "proponi_prompt_agente", "ricorda"]));
    expect(rec.stdin).toContain("[utente]\nMigliora il prompt dell'agente");
    expect(argAfter(rec.args, "--model")).toBe("sonnet");
    expect(argAfter(rec.args, "--max-turns")).toBe("7");
    expect(argAfter(rec.args, "--system-prompt")).toContain("mcp__botcave__");
    expect(turnToolCalls).toEqual(["proponi_prompt_agente"]);

    const [turn] = await db.select().from(nodeTurnsTable);
    expect(turn).toMatchObject({ consumer: "character", refId: conv.json.id, status: "done", package: null, costUsd: "0.001000", sessionId: "s" });
  });

  it("run di un agente: claude finto chiama un tool L2 su /mcp/turn → voce in «Da confermare» e run succeeded", async () => {
    const { agentId } = await seedApp([DELETE_ITEM]);
    process.env["FAKE_CLAUDE_PLAN"] = JSON.stringify({
      tool: "delete_item",
      arguments: { id: "7", destinatario: "Rosa", sintesi: "Elimina l'elemento 7" },
      result: "Eliminazione dell'elemento 7 in attesa di conferma.",
    });
    await startNode(FAKE_CLAUDE);

    const started = await api("POST", `/agents/${agentId}/runs`, { input: "Elimina l'elemento 7" });
    expect(started.status, started.text).toBe(202);
    const run = await until("run chiusa", async () => {
      const r = await api("GET", `/runs/${started.json.id}`);
      return ["succeeded", "failed", "cancelled"].includes(r.json?.status) ? r.json : null;
    });
    expect(run).toMatchObject({ status: "succeeded", output: "Eliminazione dell'elemento 7 in attesa di conferma." });

    const queued = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.runId, started.json.id));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "action", status: "pending", number: 1, recipient: "Rosa", summary: "Elimina l'elemento 7" });

    const rec = await readRecord();
    expect(rec.tools).toEqual(expect.arrayContaining(["delete_item"]));
    expect(rec.callText).toBe("accodata come n. 1, in attesa di conferma dell'utente");
    // Responsabile di prodotto: 12 giri + 1
    expect(argAfter(rec.args, "--max-turns")).toBe("13");
    expect(turnToolCalls).toEqual(["delete_item"]);

    const steps = await db.select().from(runStepsTable).where(eq(runStepsTable.runId, started.json.id)).orderBy(runStepsTable.position);
    expect(steps.map((s) => s.type)).toEqual(expect.arrayContaining(["queued", "model"]));
    expect(steps.find((s) => s.type === "model")?.note).toBe("Claude Code sul nodo «Mac di Ivan»");
    const [turn] = await db.select().from(nodeTurnsTable).where(and(eq(nodeTurnsTable.consumer, "run"), eq(nodeTurnsTable.refId, started.json.id)));
    expect(turn).toMatchObject({ status: "done", package: null });
  });

  it.runIf(REAL_CLAUDE)(
    "claude vero (haiku): Alfred scritto chiama squadre_stato su /mcp/turn e risponde",
    async () => {
      const [haiku] = await db
        .insert(aiModelsTable)
        .values({ accountId: (await db.select().from(aiModelsTable).where(eq(aiModelsTable.id, setup.aiModelId)))[0]!.accountId, modelId: "haiku", displayName: "haiku (ultimo)" })
        .returning();
      await db.update(usersTable).set({ alfredChatAiModelId: haiku!.id }).where(eq(usersTable.id, setup.userId));
      await startNode("claude");

      const thread = await api("GET", "/characters/alfred/thread");
      expect(thread.status, thread.text).toBe(200);
      const t0 = Date.now();
      const sent = await api("POST", `/character-conversations/${thread.json.id}/messages`, {
        content: "Usa lo strumento squadre_stato e dimmi quante squadre attive ho.",
      });
      expect(sent.status, sent.text).toBe(202);
      await until(
        "turno di Alfred chiuso",
        async () => {
          const r = await api("GET", `/character-conversations/${thread.json.id}`);
          return r.json?.turnStatus === "idle" ? r.json : null;
        },
        170_000,
      );
      const seconds = (Date.now() - t0) / 1000;
      const messages = await db.select().from(characterMessagesTable).where(eq(characterMessagesTable.conversationId, thread.json.id)).orderBy(characterMessagesTable.id);
      const [turn] = await db.select().from(nodeTurnsTable);
      // Esito per il resoconto della prova (niente token né prompt)
      process.stderr.write(
        `\n[claude vero] durata ${seconds.toFixed(1)} s, turno ${turn?.status}/${turn?.errorCode ?? "-"}, costo ${turn?.costUsd} USD, ` +
          `token ${turn?.promptTokens}+${turn?.completionTokens}, strumenti ${JSON.stringify(turnToolCalls)}\n` +
          `[claude vero] risposta: ${messages.at(-1)?.content}\n`,
      );
      expect(turn).toMatchObject({ status: "done" });
      expect(messages.at(-1)).toMatchObject({ role: "assistant", error: false });
      expect(turnToolCalls).toContain("squadre_stato");
    },
    180_000,
  );
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  appsTable,
  agentsTable,
  appToolsTable,
  runsTable,
  runStepsTable,
  type InsertAppTool,
} from "@workspace/db";
import {
  ResumeConflictError,
  expireStalePausedRuns,
  failInterruptedRuns,
  resumeRun,
  startRun,
} from "./run-executor";
import { clearUserToken } from "./user-tokens";

// Finto LiteLLM: risposte in coda, una per chiamata
let llmReplies: unknown[];
let llmRequests: any[];
// Finta app: registra le richieste ricevute
let appRequests: { method: string; url: string; auth: string | undefined; body: string }[];
// Ritardo della finta app (ms), per misurare il tempo attivo
let appDelayMs = 0;
// Finto LiteLLM che non risponde mai
let llmHangs = false;

let llm: http.Server;
let app: http.Server;
let appBase: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["AI_GATEWAY_BASE_URL", "AI_GATEWAY_API_KEY", "CASELLO_SECRET_KEY"] as const;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

function toolCallReply(name: string, args: Record<string, unknown>, id = "call_1") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

// Argomenti grezzi, così come li produce il modello (anche JSON non valido)
function rawToolCallReply(name: string, rawArgs: string, id = "call_1") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: rawArgs } }],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function textReply(text: string) {
  return {
    choices: [{ message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  llmReplies = [];
  llmRequests = [];
  appRequests = [];
  appDelayMs = 0;
  llmHangs = false;
  llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      llmRequests.push(JSON.parse(raw));
      if (llmHangs) return;
      const reply = llmReplies.shift() ?? textReply("(nessuna risposta prevista)");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  app = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      appRequests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: raw });
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: 42, name: "Rosa" }));
      }, appDelayMs);
    });
  });
  const llmPort = await listen(llm);
  const appPort = await listen(app);
  appBase = `http://127.0.0.1:${appPort}/api`;
  process.env["AI_GATEWAY_BASE_URL"] = `http://127.0.0.1:${llmPort}/v1`;
  process.env["AI_GATEWAY_API_KEY"] = "sk-test";
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  // Gli id delle run ripartono da 1: nessun token in memoria deve passare da un test all'altro
  for (let id = 1; id <= 10; id++) clearUserToken(id);
});

// Il DB di prova è condiviso tra i file: lo si lascia vuoto
afterAll(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

afterEach(async () => {
  vi.restoreAllMocks();
  llm.closeAllConnections();
  await new Promise((r) => llm.close(r));
  await new Promise((r) => app.close(r));
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const GET_ITEM: Partial<InsertAppTool> = {
  name: "get_item",
  description: "Legge un elemento",
  kind: "http",
  identity: "user",
  readOnly: true,
  status: "active",
  paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  definition: { method: "GET", path: "/items/{id}", paramLocations: { id: "path" } },
};

const DELETE_ITEM: Partial<InsertAppTool> = {
  name: "delete_item",
  description: "Elimina un elemento",
  kind: "http",
  identity: "user",
  requiresConfirmation: true,
  status: "active",
  paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  definition: { method: "DELETE", path: "/items/{id}", paramLocations: { id: "path" } },
};

const SET_PASSWORD: Partial<InsertAppTool> = {
  name: "set_password",
  description: "Cambia la password",
  kind: "http",
  identity: "user",
  requiresConfirmation: true,
  status: "active",
  paramsSchema: {
    type: "object",
    properties: { id: { type: "string" }, password: { type: "string", "x-sensitive": true } },
    required: ["id", "password"],
  },
  definition: { method: "PATCH", path: "/items/{id}", paramLocations: { id: "path", password: "body" } },
};

async function seedRun(tool: Partial<InsertAppTool>): Promise<number> {
  const [a] = await db
    .insert(appsTable)
    .values({
      name: "Mister",
      slug: "mister",
      description: "Gestione della squadra",
      baseUrl: "http://mister.example",
      internalBaseUrl: appBase,
      userAuth: { header: "authorization", scheme: "Bearer" },
    })
    .returning();
  const [agent] = await db
    .insert(agentsTable)
    .values({
      appId: a!.id,
      name: "Generale",
      role: "general",
      status: "active",
      model: "openrouter/auto",
      systemPrompt: "Aiuta l'allenatore.",
    })
    .returning();
  await db.insert(appToolsTable).values({ appId: a!.id, ...tool } as InsertAppTool);
  const [run] = await db.insert(runsTable).values({ agentId: agent!.id, input: "Fai il lavoro" }).returning();
  return run!.id;
}

async function getRun(id: number) {
  const [run] = await db.select().from(runsTable).where(eq(runsTable.id, id));
  return run!;
}

async function getSteps(id: number) {
  return db.select().from(runStepsTable).where(eq(runStepsTable.runId, id)).orderBy(runStepsTable.position);
}

describe("orchestrazione delle run", () => {
  it("run con tool: succeeded, l'app riceve la richiesta, 3 passi", async () => {
    const id = await seedRun(GET_ITEM);
    llmReplies = [toolCallReply("get_item", { id: "42" }), textReply("Elemento 42: Rosa")];

    await startRun(id, { userToken: "tok-1" });

    const run = await getRun(id);
    expect(run.status).toBe("succeeded");
    expect(run.output).toBe("Elemento 42: Rosa");
    expect(run.promptTokens).toBe(20);
    expect(run.completionTokens).toBe(10);
    expect(run.durationMs).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(appRequests).toHaveLength(1);
    expect(appRequests[0]).toMatchObject({ method: "GET", url: "/api/items/42", auth: "Bearer tok-1" });

    const steps = await getSteps(id);
    expect(steps.map((s) => [s.position, s.type, s.toolName, s.ok])).toEqual([
      [0, "model", null, true],
      [1, "tool", "get_item", true],
      [2, "model", null, true],
    ]);
    expect(steps[1]!.httpStatus).toBe(200);
    expect(steps[1]!.args).toEqual({ id: "42" });

    // Contesto di sistema con app e istruzioni, tool come function calling (non in elenco testuale)
    const first = llmRequests[0];
    expect(first.model).toBe("openrouter/auto");
    expect(first.tools.map((t: any) => t.function.name)).toEqual(["get_item"]);
    const system = first.messages[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("Mister");
    expect(system.content).toContain("Aiuta l'allenatore.");
    expect(system.content).not.toContain("Strumenti disponibili");
    expect(first.messages[1]).toEqual({ role: "user", content: "Fai il lavoro" });
  });

  it("token utente non salvato: nessuna colonna di runs o run_steps lo contiene", async () => {
    const id = await seedRun(GET_ITEM);
    llmReplies = [toolCallReply("get_item", { id: "42" }), textReply("fatto")];

    await startRun(id, { userToken: "segreto-utente" });

    expect(appRequests[0]!.auth).toBe("Bearer segreto-utente");
    const runs = await pool.query("select row_to_json(r)::text as j from runs r");
    const steps = await pool.query("select row_to_json(s)::text as j from run_steps s");
    for (const row of [...runs.rows, ...steps.rows]) expect(row.j).not.toContain("segreto-utente");
  });

  it("tool user senza token: passo tool fallito con 'token utente mancante', run succeeded", async () => {
    const id = await seedRun(GET_ITEM);
    llmReplies = [toolCallReply("get_item", { id: "42" }), textReply("Non posso: manca il token.")];

    await startRun(id);

    const run = await getRun(id);
    expect(run.status).toBe("succeeded");
    expect(appRequests).toHaveLength(0);
    const tool = (await getSteps(id)).find((s) => s.type === "tool")!;
    expect(tool.ok).toBe(false);
    expect(tool.error).toContain("token utente mancante");
  });

  it("pausa e ripresa: awaiting_client, poi una sola richiesta all'app; seconda ripresa in conflitto", async () => {
    const id = await seedRun(DELETE_ITEM);
    llmReplies = [toolCallReply("delete_item", { id: "42" }), textReply("Eliminato.")];

    await startRun(id, { userToken: "segreto-utente" });

    let run = await getRun(id);
    expect(run.status).toBe("awaiting_client");
    expect(run.pendingAction).toMatchObject({ kind: "confirmation", toolName: "delete_item", args: { id: "42" } });
    expect(run.pausedAt).not.toBeNull();
    expect(run.loopState).not.toBeNull();
    expect(appRequests).toHaveLength(0);
    // Durante la pausa il token resta solo in memoria
    const paused = await pool.query("select row_to_json(r)::text as j from runs r");
    expect(paused.rows[0].j).not.toContain("segreto-utente");

    await resumeRun(id, "approved");

    run = await getRun(id);
    expect(run.status).toBe("succeeded");
    expect(run.output).toBe("Eliminato.");
    expect(run.pendingAction).toBeNull();
    expect(run.promptTokens).toBe(20);
    expect(appRequests).toHaveLength(1);
    expect(appRequests[0]).toMatchObject({ method: "DELETE", url: "/api/items/42", auth: "Bearer segreto-utente" });
    const steps = await getSteps(id);
    expect(steps.map((s) => [s.position, s.type, s.toolName, s.ok])).toEqual([
      [0, "model", null, true],
      [1, "tool", "delete_item", true],
      [2, "model", null, true],
    ]);

    await expect(resumeRun(id, "approved")).rejects.toBeInstanceOf(ResumeConflictError);
    expect(appRequests).toHaveLength(1);
  });

  it("ripresa con token nuovo: sostituisce quello in memoria", async () => {
    const id = await seedRun(DELETE_ITEM);
    llmReplies = [toolCallReply("delete_item", { id: "42" }), textReply("Eliminato.")];
    await startRun(id);
    await resumeRun(id, "approved", { userToken: "tok-nuovo" });
    expect(appRequests[0]!.auth).toBe("Bearer tok-nuovo");
  });

  it("due riprese concorrenti: una sola esecuzione del tool", async () => {
    const id = await seedRun(DELETE_ITEM);
    llmReplies = [toolCallReply("delete_item", { id: "42" }), textReply("Eliminato.")];
    await startRun(id, { userToken: "t" });

    const results = await Promise.allSettled([resumeRun(id, "approved"), resumeRun(id, "approved")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ResumeConflictError);
    expect(appRequests).toHaveLength(1);
  });

  it("rifiuto: l'app non riceve nulla, il modello riceve l'annullamento, run succeeded", async () => {
    const id = await seedRun(DELETE_ITEM);
    llmReplies = [toolCallReply("delete_item", { id: "42" }), textReply("Va bene, non elimino.")];
    await startRun(id, { userToken: "t" });

    await resumeRun(id, "rejected");

    const run = await getRun(id);
    expect(run.status).toBe("succeeded");
    expect(appRequests).toHaveLength(0);
    const tool = (await getSteps(id)).find((s) => s.type === "tool")!;
    expect(tool.ok).toBe(false);
    expect(tool.error).toBe("L'utente ha annullato l'azione.");
    const last = llmRequests.at(-1);
    expect(last.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "L'utente ha annullato l'azione.",
    });
  });

  it("ripresa di una run non in pausa: ResumeConflictError", async () => {
    const id = await seedRun(GET_ITEM);
    await expect(resumeRun(id, "approved")).rejects.toBeInstanceOf(ResumeConflictError);
    expect((await getRun(id)).status).toBe("pending");
  });

  it("scadenza: pausa di 11 minuti fa → cancelled", async () => {
    const id = await seedRun(DELETE_ITEM);
    llmReplies = [toolCallReply("delete_item", { id: "42" })];
    await startRun(id, { userToken: "t" });
    await db
      .update(runsTable)
      .set({ pausedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(runsTable.id, id));

    // Scaduta ma non ancora chiusa dal timer: la ripresa è comunque rifiutata
    await expect(resumeRun(id, "approved")).rejects.toBeInstanceOf(ResumeConflictError);

    expect(await expireStalePausedRuns()).toBe(1);
    const run = await getRun(id);
    expect(run.status).toBe("cancelled");
    expect(run.errorMessage).toBe("Conferma non arrivata entro 10 minuti.");
    expect(run.finishedAt).not.toBeNull();
    // R12: a run chiusa non restano argomenti dei tool
    expect(run.pendingAction).toBeNull();
    expect(run.loopState).toBeNull();
    expect(appRequests).toHaveLength(0);
    expect(await expireStalePausedRuns()).toBe(0);
  });

  it("pausa recente: non scade", async () => {
    const id = await seedRun(DELETE_ITEM);
    llmReplies = [toolCallReply("delete_item", { id: "42" })];
    await startRun(id, { userToken: "t" });
    expect(await expireStalePausedRuns()).toBe(0);
    expect((await getRun(id)).status).toBe("awaiting_client");
    clearUserToken(id);
  });

  it("stato di pausa incoerente: ResumeConflictError, la run finisce failed e il tool non parte", async () => {
    const id = await seedRun(DELETE_ITEM);
    llmReplies = [toolCallReply("delete_item", { id: "42" })];
    await startRun(id, { userToken: "t" });
    const run = await getRun(id);
    const state = run.loopState as { queue: unknown[] };
    await db
      .update(runsTable)
      .set({ loopState: { ...state, queue: [] } })
      .where(eq(runsTable.id, id));

    await expect(resumeRun(id, "approved")).rejects.toBeInstanceOf(ResumeConflictError);
    const after = await getRun(id);
    expect(after.status).toBe("failed");
    expect(after.errorMessage).toBeTruthy();
    expect(appRequests).toHaveLength(0);
  });

  it("errore inatteso (stato di pausa mancante): la run finisce failed, non running", async () => {
    const id = await seedRun(GET_ITEM);
    // Stato di pausa mancante: la ripresa non può proseguire
    await db
      .update(runsTable)
      .set({ status: "awaiting_client", pausedAt: new Date(), loopState: null, pendingAction: null })
      .where(eq(runsTable.id, id));

    await resumeRun(id, "approved");

    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toBeTruthy();
    expect(run.finishedAt).not.toBeNull();
  });

  it("errore del modello: la run finisce failed con il messaggio", async () => {
    const id = await seedRun(GET_ITEM);
    delete process.env["AI_GATEWAY_API_KEY"];

    await startRun(id);

    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("errore nella chiamata al modello");
  });

  it("failInterruptedRuns: la run ripresa e interrotta perde stato e azione in sospeso", async () => {
    const id = await seedRun(DELETE_ITEM);
    llmReplies = [toolCallReply("delete_item", { id: "42" })];
    await startRun(id, { userToken: "t" });
    // Come dopo la transizione della ripresa: running con stato ancora salvato
    await db.update(runsTable).set({ status: "running" }).where(eq(runsTable.id, id));

    expect(await failInterruptedRuns()).toBe(1);
    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.pendingAction).toBeNull();
    expect(run.loopState).toBeNull();
    clearUserToken(id);
  });

  it("tool disattivato durante la pausa: errore al modello, argomenti sensibili oscurati nel passo", async () => {
    const id = await seedRun(SET_PASSWORD);
    llmReplies = [toolCallReply("set_password", { id: "42", password: "segreta-123" }), textReply("Non disponibile.")];
    await startRun(id, { userToken: "t" });
    await db.update(appToolsTable).set({ status: "disabled" }).where(eq(appToolsTable.name, "set_password"));

    await resumeRun(id, "approved");

    expect(appRequests).toHaveLength(0);
    expect((await getRun(id)).status).toBe("succeeded");
    const tool = (await getSteps(id)).find((s) => s.type === "tool")!;
    expect(tool.ok).toBe(false);
    expect(tool.error).toContain("non è più disponibile");
    expect(tool.args).toEqual({ id: "42", password: "***" });
    const steps = await pool.query("select row_to_json(s)::text as j from run_steps s");
    for (const row of steps.rows) expect(row.j).not.toContain("segreta-123");
  });

  it("tool cancellato durante la pausa: il passo non registra gli argomenti", async () => {
    const id = await seedRun(SET_PASSWORD);
    llmReplies = [toolCallReply("set_password", { id: "42", password: "segreta-123" }), textReply("Non disponibile.")];
    await startRun(id, { userToken: "t" });
    await db.delete(appToolsTable).where(eq(appToolsTable.name, "set_password"));

    await resumeRun(id, "approved");

    const tool = (await getSteps(id)).find((s) => s.type === "tool")!;
    expect(tool.ok).toBe(false);
    expect(tool.args).toBeNull();
  });

  it("il tempo del tool confermato alla ripresa conta nel tempo attivo del turno", async () => {
    const id = await seedRun(DELETE_ITEM);
    llmReplies = [
      toolCallReply("delete_item", { id: "1" }, "call_1"),
      toolCallReply("delete_item", { id: "2" }, "call_2"),
    ];
    await startRun(id, { userToken: "t" });
    const before = (await getRun(id)).loopState as { activeMs: number };
    appDelayMs = 150;

    await resumeRun(id, "approved");

    const run = await getRun(id);
    expect(run.status).toBe("awaiting_client");
    const after = run.loopState as { activeMs: number };
    expect(after.activeMs - before.activeMs).toBeGreaterThanOrEqual(150);
    clearUserToken(id);
  });

  it("errore inatteso a metà turno: la run failed conserva i token già consumati", async () => {
    const id = await seedRun(GET_ITEM);
    // Un carattere NUL negli argomenti non è memorizzabile in jsonb: la scrittura del passo fallisce
    llmReplies = [toolCallReply("get_item", { id: "a\u0000b" })];

    await startRun(id, { userToken: "t" });

    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("Errore durante l'esecuzione");
    expect(run.promptTokens).toBe(10);
    expect(run.completionTokens).toBe(5);
    expect(run.durationMs).not.toBeNull();
  });

  it("argomenti JSON non validi: il passo registra un oggetto { _raw } troncato a 500 caratteri", async () => {
    const id = await seedRun(GET_ITEM);
    const long = `{non json ${"x".repeat(1000)}`;
    llmReplies = [rawToolCallReply("get_item", "{non json"), rawToolCallReply("get_item", long), textReply("ok")];

    await startRun(id, { userToken: "t" });

    expect((await getRun(id)).status).toBe("succeeded");
    const tools = (await getSteps(id)).filter((s) => s.type === "tool");
    expect(tools[0]!.args).toEqual({ _raw: "{non json" });
    expect(tools[1]!.args).toEqual({ _raw: long.slice(0, 500) });
  });

  it("argomenti JSON che non sono un oggetto: registrati come { _raw } con il JSON", async () => {
    const id = await seedRun(GET_ITEM);
    llmReplies = [rawToolCallReply("get_item", "[1,2]"), textReply("ok")];

    await startRun(id, { userToken: "t" });

    const tool = (await getSteps(id)).find((s) => s.type === "tool")!;
    expect(tool.args).toEqual({ _raw: "[1,2]" });
  });

  it("argomenti non oggetto di un tool con proprietà sensibili: { _raw: '***' }", async () => {
    const id = await seedRun(SET_PASSWORD);
    llmReplies = [rawToolCallReply("set_password", '{"password":"segreta-123"'), textReply("ok")];

    await startRun(id, { userToken: "t" });

    const tool = (await getSteps(id)).find((s) => s.type === "tool")!;
    expect(tool.args).toEqual({ _raw: "***" });
    const steps = await pool.query("select row_to_json(s)::text as j from run_steps s");
    for (const row of steps.rows) expect(row.j).not.toContain("segreta-123");
  });

  it("tool sconosciuto: il passo non registra gli argomenti", async () => {
    const id = await seedRun(GET_ITEM);
    llmReplies = [rawToolCallReply("non_esiste", "{non json"), textReply("ok")];

    await startRun(id, { userToken: "t" });

    const tool = (await getSteps(id)).find((s) => s.type === "tool")!;
    expect(tool.args).toBeNull();
  });

  it("modello che non risponde: la run finisce failed entro il tempo attivo del turno", async () => {
    const id = await seedRun(GET_ITEM);
    llmHangs = true;
    const t0 = Date.now();

    await startRun(id, { userToken: "t", limits: { maxActiveMs: 300 } });

    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("errore nella chiamata al modello");
    // Tempo rimanente con un minimo di 1 s, più un margine
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(llmRequests).toHaveLength(1);
  });
});

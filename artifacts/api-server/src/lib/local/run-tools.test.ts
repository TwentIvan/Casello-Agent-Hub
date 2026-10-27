import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db, pool, agentsTable, aiAccountsTable, aiModelsTable, appsTable, runsTable, usersTable, type LocalJob } from "@workspace/db";
import { callTool, mcpClientFor } from "../../../test/fake-local-agent";
import { DEFAULT_LIMITS, type StepRecord } from "../agent-loop";
import { ensureProviderRegistry } from "../catalog/provider-registry";
import { toFunctionTools } from "../tools/catalog";
import type { CatalogTool, ToolResult } from "../tools/types";
import { claimJob, createLocalJob, jobByToken, nextForMachine } from "./jobs";
import { registerMachine } from "./machines";
import { createMcpServer } from "./mcp-server";
import { closeRunContext, openRunContext, runTurnDelegated, type RunToolsContext, type RunTurnOutcome } from "./run-tools";

// Strumenti MCP dei lavori `run`: i tool `http` dell'agente (eseguiti da Casello con la preparazione del ciclo
// dell'agente) e `finish_run`, che chiude il turno. Il contesto della run lo apre l'orchestratore: qui a mano.

const tool = (over: Partial<CatalogTool>): CatalogTool =>
  ({
    id: 1,
    appId: 1,
    name: "get_item",
    description: "Legge un elemento",
    kind: "http",
    identity: "user",
    readOnly: true,
    requiresConfirmation: false,
    status: "active",
    paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    definition: { method: "GET", path: "/items/{id}", paramLocations: { id: "path" } },
    ...over,
  }) as CatalogTool;

const GET_ITEM = tool({});

let userId: number;
let machineId: number;
let runId: number;
let jobId: number;
let jobToken: string;
let fallbackModelId: number;
let executed: Array<{ name: string; args: Record<string, unknown> }>;
let steps: StepRecord[];
let controllers: AbortController[] = [];
let closers: Array<() => Promise<void>> = [];

function signal() {
  const ac = new AbortController();
  controllers.push(ac);
  return ac.signal;
}

function open(over: Partial<Parameters<typeof openRunContext>[1]> = {}): RunToolsContext {
  return openRunContext(runId, {
    tools: [GET_ITEM],
    limits: DEFAULT_LIMITS,
    rounds: 0,
    activeMs: 0,
    execute: async (t, args): Promise<ToolResult> => {
      executed.push({ name: t.name, args });
      return { ok: true, status: 200, content: `risultato di ${t.name}` };
    },
    writeStep: async (s) => {
      steps.push(s);
    },
    ...over,
  });
}

async function client(): Promise<Client> {
  const job = (await jobByToken(jobToken)) as LocalJob;
  const c = await mcpClientFor(job);
  closers.push(c.close);
  return c.client;
}

/** Turno delegato (come lo avvia l'orchestratore); consegnato al runner salvo `delivered: false`. */
async function startTurn(delivered = true): Promise<{ done: Promise<RunTurnOutcome> }> {
  const done = runTurnDelegated({ jobId, runId, prompt: "fai il lavoro", resume: false });
  for (let i = 0; i < 100; i++) {
    if ((await jobByToken(jobToken))?.currentItem) {
      if (delivered) {
        const d = await nextForMachine(machineId, signal());
        if (!d) throw new Error("nessun compito consegnato");
        jobToken = d.jobToken;
      }
      return { done };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("compito non pubblicato");
}

// Il provider `local_agent` dell'account "Agente locale" sta nel registro dei provider
beforeAll(async () => {
  await ensureProviderRegistry();
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  const [user] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
  userId = user!.id;
  const { machine } = await registerMachine(userId, "MacBook");
  machineId = machine.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "API", provider: "custom", baseUrl: "https://api.example.com/v1", status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "m" }).returning();
  fallbackModelId = model!.id;
  const [app] = await db.insert(appsTable).values({ name: "App", slug: "app", baseUrl: "https://app.example.com" }).returning();
  const [agent] = await db.insert(agentsTable).values({ appId: app!.id, name: "Agente" }).returning();
  const [run] = await db.insert(runsTable).values({ agentId: agent!.id, status: "running", input: "x" }).returning();
  runId = run!.id;
  const job = await createLocalJob({ userId, machineId, kind: "run", runId, fallbackAiModelId: model!.id, origin: "console" });
  jobId = job.id;
  ({ jobToken } = await claimJob(job.id, { by: "runner", machineId }));
  executed = [];
  steps = [];
});

afterEach(async () => {
  for (const ac of controllers) ac.abort();
  controllers = [];
  for (const close of closers.splice(0)) await close();
  closeRunContext(runId);
});

describe("strumenti MCP delle run", () => {
  it("elenco: finish_run e i tool http dell'agente con nome, descrizione e schema del function calling", async () => {
    const sensitive = tool({
      id: 2,
      name: "login",
      description: "Accede",
      readOnly: false,
      paramsSchema: { type: "object", properties: { password: { type: "string", "x-sensitive": true } } },
    });
    const ui = tool({ id: 3, name: "apri_pagina", kind: "ui" });
    open({ tools: [GET_ITEM, sensitive, ui] });
    const { done } = await startTurn();
    const tools = (await (await client()).listTools()).tools;

    expect(tools.map((t) => t.name)).toEqual(["get_job", "finish_run", "get_item", "login"]);
    const expected = toFunctionTools([GET_ITEM, sensitive]).map((t) => (t.type === "function" ? t.function : null));
    expect(tools.slice(2).map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }))).toEqual(expected);
    await callTool(await client(), "finish_run", { content: "fine" });
    await done;
  });

  it("tool di lettura: eseguito da Casello, passo registrato, risultato a Claude; finish_run chiude il turno", async () => {
    open();
    const { done } = await startTurn();
    const c = await client();

    expect(await callTool(c, "get_item", { id: "42" })).toEqual({ text: "risultato di get_item", isError: false });
    expect(executed).toEqual([{ name: "get_item", args: { id: "42" } }]);
    expect(steps).toEqual([expect.objectContaining({ type: "tool", toolName: "get_item", args: { id: "42" }, ok: true, httpStatus: 200 })]);

    // Argomenti di finish_run non validi: errore, il turno resta aperto
    expect(await callTool(c, "finish_run", { content: 3 })).toEqual({ text: "argomenti non validi: content (testo) è obbligatorio", isError: true });
    expect(await callTool(c, "finish_run", { content: "fatto" })).toEqual({ text: "risposta ricevuta: run completata, termina ora", isError: false });
    expect(await done).toEqual({ kind: "finished", content: "fatto" });
  });

  it("tool fallito: errore a Claude, passo registrato, conta come giro", async () => {
    const ctx = open();
    const { done } = await startTurn();
    const c = await client();
    // L'esecutore vero valida gli argomenti; qui quello finto restituisce l'errore come farebbe lui
    ctx.execute = async () => ({ ok: false, content: "argomenti non validi: id obbligatorio" });

    expect(await callTool(c, "get_item", {})).toEqual({ text: "argomenti non validi: id obbligatorio", isError: true });
    expect(ctx.rounds).toBe(1);
    expect(steps[0]).toMatchObject({ toolName: "get_item", ok: false, error: "argomenti non validi: id obbligatorio" });
    await callTool(c, "finish_run", { content: "ok" });
    await done;
  });

  it("compito pubblicato ma non consegnato: nessuno strumento viene eseguito", async () => {
    open();
    const { done } = await startTurn(false);
    const c = await client();

    expect(await callTool(c, "get_item", { id: "1" })).toEqual({ text: "compito non più in corso", isError: true });
    expect(await callTool(c, "finish_run", { content: "x" })).toEqual({ text: "compito non più in corso", isError: true });
    expect(executed).toHaveLength(0);
    expect(steps).toHaveLength(0);
    // Consegnato, la sessione nuova lavora
    const d = await nextForMachine(machineId, signal());
    jobToken = d!.jobToken;
    await callTool(await client(), "finish_run", { content: "fine" });
    expect(await done).toEqual({ kind: "finished", content: "fine" });
  });

  it("tempo attivo esaurito: il tool non parte e il turno fallisce", async () => {
    let clock = 0;
    open({ now: () => clock, limits: { ...DEFAULT_LIMITS, maxActiveMs: 1000 }, activeMs: 400 });
    const { done } = await startTurn();
    const c = await client();
    clock = 600;

    expect(await callTool(c, "get_item", { id: "1" })).toEqual({ text: "non eseguito: tempo massimo del turno superato. Termina ora.", isError: true });
    expect(executed).toHaveLength(0);
    expect(await done).toEqual({ kind: "failed", error: "tempo massimo del turno superato" });
  });

  it("senza contesto (run finita o riavvio): solo finish_run, che risponde 'lavoro scaduto'", async () => {
    const c = await client();
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["get_job", "finish_run"]);
    expect(await callTool(c, "finish_run", { content: "x" })).toEqual({ text: "lavoro scaduto", isError: true });
  });

  it("chat (token personale): gli strumenti della run con casello_job_id", async () => {
    // Lavoro nuovo preso dalla chat
    await pool.query("UPDATE local_jobs SET status = 'cancelled'");
    const job = await createLocalJob({ userId, machineId, kind: "run", runId, fallbackAiModelId: fallbackModelId, origin: "console" });
    jobId = job.id;
    await claimJob(job.id, { by: "chat", userId });
    open();
    const done = runTurnDelegated({ jobId, runId, prompt: "fai", resume: false });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ kind: "personal", userId });
    await server.connect(serverSide);
    const c = new Client({ name: "chat", version: "0" });
    await c.connect(clientSide);
    closers.push(async () => {
      await c.close();
      await server.close();
    });
    for (let i = 0; i < 100 && !(await c.listTools()).tools.some((t) => t.name === "get_item"); i++) await new Promise((r) => setTimeout(r, 5));

    expect(await callTool(c, "get_item", { id: "7", casello_job_id: jobId })).toEqual({ text: "risultato di get_item", isError: false });
    expect(executed).toEqual([{ name: "get_item", args: { id: "7" } }]);
    await callTool(c, "finish_run", { content: "dalla chat", casello_job_id: jobId });
    expect(await done).toEqual({ kind: "finished", content: "dalla chat" });
  });
});

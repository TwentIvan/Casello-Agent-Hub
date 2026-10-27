import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  localJobsTable,
  localMachinesTable,
  mcpTokensTable,
  runsTable,
  usersTable,
} from "@workspace/db";
import { ensureProviderRegistry } from "../lib/catalog/provider-registry";
import { logger } from "../lib/logger";
import { hashToken } from "../lib/local/tokens";
import type * as Jobs from "../lib/local/jobs";
import type * as McpServer from "../lib/local/mcp-server";
import type * as McpRoutes from "./mcp";

// Server MCP (/api/mcp) con il client MCP dell'SDK su un'app Express vera, senza login della console
// (AUTH_DISABLED=true: l'utente della console è dev@localhost, che crea macchine e token personali).

let base: string;
let server: http.Server;
let jobs: typeof Jobs;
let mcp: typeof McpServer;
let mcpRoutes: typeof McpRoutes;
const unregister: Array<() => void> = [];
const calls: Array<{ jobId: number; userId: number; args: unknown }> = [];

const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL"] as const;
const saved: Record<string, string | undefined> = {};

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}
let clients: Client[] = [];

/** Testo del primo contenuto di un risultato di strumento. */
function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

async function devUserId(): Promise<number> {
  await call("GET", "/auth/me");
  const [u] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  return u!.id;
}

async function registerMachine(name = "MacBook") {
  const res = await call("POST", "/local/machines", { body: { name } });
  expect(res.status, res.text).toBe(201);
  return { machineId: res.json.machine.id as number, token: res.json.token as string };
}

async function personalToken() {
  const res = await call("POST", "/local/tokens", { body: { name: "Claude Desktop" } });
  expect(res.status, res.text).toBe(201);
  return { tokenId: res.json.personalToken.id as number, token: res.json.token as string };
}

async function fixtures(userId: number) {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "API", provider: "custom", baseUrl: "https://api.example.com/v1", status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "m" }).returning();
  const [app] = await db.insert(appsTable).values({ name: "App", slug: "app", baseUrl: "https://app.example.com" }).returning();
  const [agent] = await db.insert(agentsTable).values({ appId: app!.id, name: "Agente" }).returning();
  const [run] = await db.insert(runsTable).values({ agentId: agent!.id, input: "ciao" }).returning();
  return { fallbackAiModelId: model!.id, runId: run!.id };
}

/** Lavoro di tipo run preso dal runner: il lavoro e il suo token. */
async function runnerJob(userId: number, machineId: number) {
  const { fallbackAiModelId, runId } = await fixtures(userId);
  const job = await jobs.createLocalJob({ userId, machineId, kind: "run", runId, fallbackAiModelId, origin: "console" });
  return jobs.claimJob(job.id, { by: "runner", machineId });
}

let controllers: AbortController[] = [];
function signal() {
  const ac = new AbortController();
  controllers.push(ac);
  return ac.signal;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "c".repeat(64);
  delete process.env["PUBLIC_APP_URL"];
  await ensureProviderRegistry();
  jobs = await import("../lib/local/jobs");
  mcp = await import("../lib/local/mcp-server");
  mcpRoutes = await import("./mcp");
  // Uno strumento fittizio per tipo di lavoro, più uno dinamico per le run
  for (const kind of ["analysis", "run"] as const) {
    unregister.push(
      mcp.registerJobTool(kind, {
        name: `dummy_${kind}`,
        description: `Strumento di prova (${kind})`,
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
        handler: async (ctx, args) => {
          calls.push({ jobId: ctx.job.id, userId: ctx.userId, args });
          if ((args as { value?: string }).value === "boom") throw new Error("segreto https://interno.example.com");
          return { text: `ok ${kind} ${ctx.job.id}` };
        },
      }),
    );
  }
  unregister.push(
    mcp.registerJobToolProvider("run", async (ctx) => [
      {
        name: "dynamic_run",
        description: `Strumento dinamico del lavoro ${ctx.job.id}`,
        inputSchema: { type: "object", properties: {} },
        handler: async (c) => ({ text: `dinamico ${c.job.id}`, isError: true }),
      },
    ]),
  );
  const { default: app } = await import("../app");
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  for (const fn of unregister) fn();
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  calls.length = 0;
  mcpRoutes.resetMcpAuthFailures();
});

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => {});
  clients = [];
  for (const ac of controllers) ac.abort();
  controllers = [];
  vi.restoreAllMocks();
});

describe("autenticazione di /api/mcp", () => {
  it("senza token, token sconosciuto, token di macchina o token personale revocato → 401", async () => {
    await devUserId();
    const { token: machineToken } = await registerMachine();
    const { tokenId, token } = await personalToken();
    for (const t of [undefined, "abc", "csl_p_" + "a".repeat(43), "csl_j_" + "a".repeat(43), machineToken]) {
      const res = await call("POST", "/mcp", { token: t, body: INITIALIZE });
      expect(res.status, String(t)).toBe(401);
      expect(res.json).toEqual({ error: "token non valido o revocato" });
    }
    expect((await call("POST", "/mcp", { token, body: INITIALIZE })).status).toBe(200);
    await db.update(mcpTokensTable).set({ revokedAt: new Date() }).where(eq(mcpTokensTable.id, tokenId));
    const revoked = await call("POST", "/mcp", { token, body: INITIALIZE });
    expect(revoked.status).toBe(401);
    expect(revoked.json).toEqual({ error: "token non valido o revocato" });
    await expect(connect(token)).rejects.toThrow();
  });

  it("token di lavoro di un lavoro chiuso → 401 lavoro scaduto", async () => {
    const userId = await devUserId();
    const { machineId } = await registerMachine();
    const { job, jobToken } = await runnerJob(userId, machineId);
    expect((await call("POST", "/mcp", { token: jobToken, body: INITIALIZE })).status).toBe(200);
    await jobs.finishLocalJob(job.id, "failed", "agente locale disconnesso");
    const res = await call("POST", "/mcp", { token: jobToken, body: INITIALIZE });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "lavoro scaduto" });
  });

  it("il token di un lavoro chiuso non conta per il limite delle autenticazioni fallite", async () => {
    const userId = await devUserId();
    const { machineId } = await registerMachine();
    const { job, jobToken } = await runnerJob(userId, machineId);
    await jobs.finishLocalJob(job.id, "completed");
    for (let i = 0; i < 35; i++) {
      const res = await call("POST", "/mcp", { token: jobToken, body: INITIALIZE });
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "lavoro scaduto" });
    }
  });

  it("ultimo uso del token personale aggiornato al più una volta al minuto", async () => {
    await devUserId();
    const { tokenId, token } = await personalToken();
    const recent = new Date(Date.now() - 30_000);
    await db.update(mcpTokensTable).set({ lastUsedAt: recent }).where(eq(mcpTokensTable.id, tokenId));
    expect((await call("POST", "/mcp", { token, body: INITIALIZE })).status).toBe(200);
    const [kept] = await db.select().from(mcpTokensTable).where(eq(mcpTokensTable.id, tokenId));
    expect(kept!.lastUsedAt!.getTime()).toBe(recent.getTime());
    await db.update(mcpTokensTable).set({ lastUsedAt: new Date(Date.now() - 120_000) }).where(eq(mcpTokensTable.id, tokenId));
    expect((await call("POST", "/mcp", { token, body: INITIALIZE })).status).toBe(200);
    const [updated] = await db.select().from(mcpTokensTable).where(eq(mcpTokensTable.id, tokenId));
    expect(updated!.lastUsedAt!.getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it("corpo fino a 2 MB accettato; oltre → 413", async () => {
    const userId = await devUserId();
    const { machineId } = await registerMachine();
    const { job, jobToken } = await runnerJob(userId, machineId);
    const client = await connect(jobToken);
    const big = "x".repeat(1024 * 1024);
    const ok = await client.callTool({ name: "dummy_run", arguments: { value: big } });
    expect(textOf(ok)).toBe(`ok run ${job.id}`);
    expect((calls[0]!.args as { value: string }).value).toHaveLength(big.length);
    const tooBig = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dummy_run", arguments: { value: "x".repeat(2 * 1024 * 1024 + 10) } } };
    const res = await call("POST", "/mcp", { token: jobToken, body: tooBig });
    expect(res.status).toBe(413);
    expect(res.json).toEqual({ error: "corpo della richiesta troppo grande" });
  });

  it("GET e DELETE → 405 (server senza stato)", async () => {
    const userId = await devUserId();
    const { machineId } = await registerMachine();
    const { jobToken } = await runnerJob(userId, machineId);
    expect((await call("GET", "/mcp", { token: jobToken })).status).toBe(405);
    expect((await call("DELETE", "/mcp", { token: jobToken })).status).toBe(405);
  });

  it("oltre 30 autenticazioni fallite al minuto per IP → 429, anche con un token valido", async () => {
    await devUserId();
    const { token } = await personalToken();
    mcpRoutes.resetMcpAuthFailures();
    try {
      for (let i = 0; i < 30; i++) expect((await call("POST", "/mcp", { token: "csl_p_" + "b".repeat(43), body: INITIALIZE })).status).toBe(401);
      const blocked = await call("POST", "/mcp", { token: "abc", body: INITIALIZE });
      expect(blocked.status).toBe(429);
      expect((await call("POST", "/mcp", { token, body: INITIALIZE })).status).toBe(429);
    } finally {
      mcpRoutes.resetMcpAuthFailures();
    }
    expect((await call("POST", "/mcp", { token, body: INITIALIZE })).status).toBe(200);
  });

  it("oltre 300 richieste al minuto per token → 429", async () => {
    await devUserId();
    const { token } = await personalToken();
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const statuses: number[] = [];
    for (let i = 0; i < 301; i++) statuses.push((await call("POST", "/mcp", { token, body: ping })).status);
    expect(statuses.slice(0, 300).every((s) => s !== 429)).toBe(true);
    expect(statuses[300]).toBe(429);
    // Un altro token ha il suo contatore
    const other = await personalToken();
    expect((await call("POST", "/mcp", { token: other.token, body: ping })).status).not.toBe(429);
  });
});

describe("token di lavoro", () => {
  it("vede get_job e solo gli strumenti del tipo del lavoro; ogni richiesta vale come segnale di vita", async () => {
    const userId = await devUserId();
    const { machineId } = await registerMachine();
    const { job, jobToken } = await runnerJob(userId, machineId);
    await db.update(localJobsTable).set({ heartbeatAt: new Date(0) }).where(eq(localJobsTable.id, job.id));

    const client = await connect(jobToken);
    const { tools } = await client.listTools();
    // finish_run: strumento delle run dell'agente locale (run-tools), registrato con l'app
    expect(tools.map((t) => t.name).sort()).toEqual(["dummy_run", "dynamic_run", "finish_run", "get_job"]);
    expect(tools.find((t) => t.name === "dynamic_run")!.description).toBe(`Strumento dinamico del lavoro ${job.id}`);

    const [row] = await db.select().from(localJobsTable).where(eq(localJobsTable.id, job.id));
    expect(row!.heartbeatAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);

    // Senza compito in corso
    const empty = JSON.parse(textOf(await client.callTool({ name: "get_job", arguments: {} })));
    expect(empty).toMatchObject({ jobId: job.id, kind: "run", prompt: null });
    expect(typeof empty.limits).toBe("string");

    // Con un compito pubblicato
    void jobs.runItem(job.id, { prompt: "Esegui la run 1", resume: false }, signal()).catch(() => {});
    for (let i = 0; i < 100; i++) {
      const [r] = await db.select().from(localJobsTable).where(eq(localJobsTable.id, job.id));
      if (r!.currentItem) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    const current = JSON.parse(textOf(await client.callTool({ name: "get_job", arguments: { casello_job_id: 999 } })));
    expect(current).toMatchObject({ jobId: job.id, kind: "run", prompt: "Esegui la run 1" });

    const result = await client.callTool({ name: "dummy_run", arguments: { value: "x" } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(`ok run ${job.id}`);
    expect(calls).toEqual([{ jobId: job.id, userId, args: { value: "x" } }]);

    const dynamic = await client.callTool({ name: "dynamic_run", arguments: {} });
    expect(dynamic.isError).toBe(true);
    expect(textOf(dynamic)).toBe(`dinamico ${job.id}`);
  });

  it("strumenti di altro tipo, sconosciuti o in errore → risultato isError con testo fisso", async () => {
    const userId = await devUserId();
    const { machineId } = await registerMachine();
    const { jobToken } = await runnerJob(userId, machineId);
    const client = await connect(jobToken);

    for (const name of ["dummy_analysis", "list_jobs", "claim_job", "inesistente"]) {
      const r = await client.callTool({ name, arguments: { job_id: 1 } });
      expect(r.isError, name).toBe(true);
      expect(textOf(r)).toBe("strumento non disponibile");
    }
    const boom = await client.callTool({ name: "dummy_run", arguments: { value: "boom" } });
    expect(boom.isError).toBe(true);
    expect(textOf(boom)).toBe("errore interno dello strumento");
  });
});

describe("errori degli strumenti", () => {
  it("un provider o uno strumento che fallisce non espone messaggio, URL o SQL (né al client né nel log)", async () => {
    const userId = await devUserId();
    const { machineId } = await registerMachine();
    const { jobToken } = await runnerJob(userId, machineId);
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const secret = 'SELECT * FROM users WHERE token = \'x\' -- https://interno.example.com/db';
    const remove = mcp.registerJobToolProvider("run", async () => {
      throw new Error(secret);
    });
    try {
      const client = await connect(jobToken);
      const listed = await client.listTools().then(
        () => null,
        (err: Error) => err.message,
      );
      expect(listed).toContain("errore interno dello strumento");
      expect(listed).not.toMatch(/SELECT|interno\.example/);
      const r = await client.callTool({ name: "dummy_run", arguments: {} });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe("errore interno dello strumento");
      expect(logged).toHaveBeenCalled();
      expect(JSON.stringify(logged.mock.calls)).not.toMatch(/SELECT|interno\.example/);
    } finally {
      remove();
    }
  });
});

describe("token personale (modalità chat)", () => {
  it("list_jobs vede solo i propri lavori in attesa; claim_job di un lavoro altrui → lavoro non trovato", async () => {
    const userId = await devUserId();
    const { machineId } = await registerMachine();
    const { tokenId, token } = await personalToken();
    const { fallbackAiModelId, runId } = await fixtures(userId);
    const own = await jobs.createLocalJob({ userId, machineId, kind: "run", runId, fallbackAiModelId, origin: "console" });
    const taken = await jobs.createLocalJob({ userId, machineId, kind: "run", runId, fallbackAiModelId, origin: "console" });
    await jobs.claimJob(taken.id, { by: "runner", machineId });
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com" }).returning();
    const [otherMachine] = await db.insert(localMachinesTable).values({ userId: other!.id, name: "PC", tokenHash: hashToken("pc") }).returning();
    const foreign = await jobs.createLocalJob({ userId: other!.id, machineId: otherMachine!.id, kind: "run", runId, fallbackAiModelId, origin: "console" });

    const client = await connect(token);
    const [usedRow] = await db.select().from(mcpTokensTable).where(eq(mcpTokensTable.id, tokenId));
    expect(usedRow!.lastUsedAt).not.toBeNull();

    // Prima della presa: niente strumenti dei lavori
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["claim_job", "get_job", "list_jobs"]);

    const list = JSON.parse(textOf(await client.callTool({ name: "list_jobs", arguments: {} })));
    expect(list).toEqual([expect.objectContaining({ id: own.id, kind: "run", status: "queued" })]);

    const stolen = await client.callTool({ name: "claim_job", arguments: { job_id: foreign.id } });
    expect(stolen.isError).toBe(true);
    expect(textOf(stolen)).toBe("lavoro non trovato");
    // Un lavoro preso dal runner non si usa dalla chat
    const runnerOnly = await client.callTool({ name: "get_job", arguments: { casello_job_id: taken.id } });
    expect(runnerOnly.isError).toBe(true);
    expect(textOf(runnerOnly)).toBe("lavoro non trovato");
    expect((await client.callTool({ name: "claim_job", arguments: {} })).isError).toBe(true);

    // La presa avvisa il client che gli strumenti sono cambiati
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed++;
    });
    const claimed = await client.callTool({ name: "claim_job", arguments: { job_id: own.id } });
    expect(claimed.isError).toBeFalsy();
    expect(textOf(claimed)).not.toMatch(/csl_j_/);
    expect(changed).toBe(1);
    const [row] = await db.select().from(localJobsTable).where(eq(localJobsTable.id, own.id));
    expect(row!.claimedBy).toBe("chat");

    // Dopo la presa: gli strumenti del tipo del lavoro, con casello_job_id obbligatorio
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["claim_job", "dummy_run", "dynamic_run", "finish_run", "get_job", "list_jobs"]);
    expect(tools.find((t) => t.name === "dummy_run")!.inputSchema.required).toContain("casello_job_id");

    const info = JSON.parse(textOf(await client.callTool({ name: "get_job", arguments: { casello_job_id: own.id } })));
    expect(info).toMatchObject({ jobId: own.id, kind: "run" });

    // Un parametro job_id del tool resta del tool: si toglie solo casello_job_id
    const ok = await client.callTool({ name: "dummy_run", arguments: { casello_job_id: own.id, job_id: 7, value: "y" } });
    expect(textOf(ok)).toBe(`ok run ${own.id}`);
    expect(calls).toEqual([{ jobId: own.id, userId, args: { job_id: 7, value: "y" } }]);

    for (const jobId of [foreign.id, taken.id, undefined]) {
      const r = await client.callTool({ name: "dummy_run", arguments: { casello_job_id: jobId, value: "y" } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe("lavoro non trovato");
    }
    const wrongKind = await client.callTool({ name: "dummy_analysis", arguments: { casello_job_id: own.id } });
    expect(wrongKind.isError).toBe(true);
    expect(textOf(wrongKind)).toBe("strumento non disponibile");
    expect(calls).toHaveLength(1);

    // Token del lavoro scaduto ma lavoro non ancora chiuso: invisibile, e touchJob non lo rianima
    const expiredAt = new Date(Date.now() - 1000);
    await db.update(localJobsTable).set({ jobTokenExpiresAt: expiredAt }).where(eq(localJobsTable.id, own.id));
    const expired = await client.callTool({ name: "get_job", arguments: { casello_job_id: own.id } });
    expect(textOf(expired)).toBe("lavoro non trovato");
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["claim_job", "get_job", "list_jobs"]);
    const [stale] = await db.select().from(localJobsTable).where(eq(localJobsTable.id, own.id));
    expect(stale!.jobTokenExpiresAt!.getTime()).toBe(expiredAt.getTime());
    await db.update(localJobsTable).set({ jobTokenExpiresAt: new Date(Date.now() + 60_000) }).where(eq(localJobsTable.id, own.id));

    // Dopo la chiusura il lavoro non c'è più
    await jobs.finishLocalJob(own.id, "completed");
    const closed = await client.callTool({ name: "get_job", arguments: { casello_job_id: own.id } });
    expect(textOf(closed)).toBe("lavoro non trovato");
  });
});

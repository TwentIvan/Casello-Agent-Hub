import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, agentsTable, aiAccountsTable, aiModelsTable, appsTable, localJobsTable, localMachinesTable, runsTable, usersTable } from "@workspace/db";
import { ensureProviderRegistry } from "../lib/catalog/provider-registry";
import { hashToken } from "../lib/local/tokens";
import type * as Jobs from "../lib/local/jobs";

// Protocollo del runner (/api/runner/*, token di macchina) e lavori dalla console (/api/local/jobs, sessione).
// App completa senza login (AUTH_DISABLED=true: l'utente della console è dev@localhost); tempi ridotti.

let base: string;
let server: http.Server;
let jobs: typeof Jobs;
let restoreTimings: () => void;
let machineIdBase = 0;

const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL"] as const;
const saved: Record<string, string | undefined> = {};

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function devUserId(): Promise<number> {
  await call("GET", "/auth/me");
  const [u] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  return u!.id;
}

/** Macchina registrata dalla console: id e token. */
async function registerMachine(name = "MacBook") {
  const res = await call("POST", "/local/machines", { body: { name } });
  expect(res.status, res.text).toBe(201);
  return { machineId: res.json.machine.id as number, token: res.json.token as string };
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
  const { default: app } = await import("../app");
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
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
  // Il rate limit del runner conta per id di macchina e vive quanto l'app: id nuovi a ogni test
  machineIdBase += 100;
  await pool.query(`ALTER SEQUENCE local_machines_id_seq RESTART WITH ${machineIdBase}`);
  restoreTimings = jobs.setLocalJobTimings({ longPollMs: 150, claimWindowMs: 100, heartbeatTimeoutMs: 2000 });
});

afterEach(() => {
  for (const ac of controllers) ac.abort();
  controllers = [];
  restoreTimings();
  vi.restoreAllMocks();
});

describe("autenticazione del runner", () => {
  it("attesa lunga di 25 s per default", () => {
    restoreTimings();
    expect(jobs.localJobTimings().longPollMs).toBe(25_000);
    restoreTimings = jobs.setLocalJobTimings({ longPollMs: 150 });
  });

  it("senza token, token errato, token non di macchina o macchina revocata → 401", async () => {
    await devUserId();
    const { machineId, token } = await registerMachine();
    for (const t of [undefined, "csl_m_" + "a".repeat(43), "abc", token.replace("csl_m_", "csl_p_")]) {
      const res = await call("GET", "/runner/next", { token: t });
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "token non valido o revocato" });
    }
    await db.update(localMachinesTable).set({ revokedAt: new Date() }).where(eq(localMachinesTable.id, machineId));
    const revoked = await call("GET", "/runner/next", { token });
    expect(revoked.status).toBe(401);
    expect(revoked.json).toEqual({ error: "token non valido o revocato" });
    // Anche le altre route del runner
    expect((await call("POST", "/runner/jobs/1/heartbeat", { token })).status).toBe(401);
    expect((await call("POST", "/runner/items/x/done", { token, body: { sessionId: null, exit: "done", usage: null } })).status).toBe(401);
  });

  it("senza lavori risponde 204 allo scadere dell'attesa e segna il segnale di vita", async () => {
    await devUserId();
    const { machineId, token } = await registerMachine();
    const started = Date.now();
    const res = await call("GET", "/runner/next", { token });
    expect(res.status).toBe(204);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    const [m] = await db.select().from(localMachinesTable).where(eq(localMachinesTable.id, machineId));
    expect(m!.lastSeenAt).not.toBeNull();
    const machines = await call("GET", "/local/machines");
    expect(machines.json[0].connected).toBe(true);
  });

  it("60 richieste al minuto per macchina, poi 429", async () => {
    await devUserId();
    const { token } = await registerMachine();
    const other = await registerMachine("PC");
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await call("POST", "/runner/jobs/999/heartbeat", { token })).status);
    expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true);
    expect(statuses[60]).toBe(429);
    // L'altra macchina ha il suo contatore
    expect((await call("POST", "/runner/jobs/999/heartbeat", { token: other.token })).status).toBe(404);
  });
});

describe("flusso next → done", () => {
  it("presa, compito con token di lavoro e indirizzo MCP, segnale di vita, done", async () => {
    const userId = await devUserId();
    const { machineId, token } = await registerMachine();
    const { fallbackAiModelId, runId } = await fixtures(userId);

    const next = call("GET", "/runner/next", { token });
    await new Promise((r) => setTimeout(r, 30));
    const job = await jobs.createLocalJob({ userId, machineId, kind: "run", runId, fallbackAiModelId, origin: "console" });
    expect(await jobs.awaitDispatch(job.id, signal())).toEqual({ kind: "local" });
    await db.update(localJobsTable).set({ claudeSessionId: "sess-0" }).where(eq(localJobsTable.id, job.id));
    const item = jobs.runItem(job.id, { prompt: "Fai la run", resume: true }, signal());

    const res = await next;
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({
      jobId: job.id,
      itemId: expect.any(String),
      jobToken: expect.stringMatching(/^csl_j_/),
      prompt: "Fai la run",
      resumeSessionId: "sess-0",
      mcpUrl: `${base}/api/mcp`,
    });
    const [row] = await db.select().from(localJobsTable).where(eq(localJobsTable.id, job.id));
    expect(row!.jobTokenHash).toBe(hashToken(res.json.jobToken));
    expect(res.text).not.toContain(row!.jobTokenHash!);

    expect((await call("POST", `/runner/jobs/${job.id}/heartbeat`, { token })).status).toBe(204);
    const bad = await call("POST", `/runner/items/${res.json.itemId}/done`, { token, body: { sessionId: 1, exit: "boh" } });
    expect(bad.status).toBe(400);
    const done = await call("POST", `/runner/items/${res.json.itemId}/done`, {
      token,
      body: { sessionId: "sess-1", exit: "done", usage: { inputTokens: 3, outputTokens: 4 } },
    });
    expect(done.status, done.text).toBe(204);
    expect(await item).toEqual({ sessionId: "sess-1", exit: "done", usage: { inputTokens: 3, outputTokens: 4 } });

    // Lavori di un'altra macchina: invisibili
    const other = await registerMachine("PC");
    expect((await call("POST", `/runner/jobs/${job.id}/heartbeat`, { token: other.token })).status).toBe(404);
    expect((await call("POST", `/runner/items/${res.json.itemId}/done`, { token: other.token, body: { sessionId: null, exit: "done", usage: null } })).status).toBe(404);

    // Dopo il riavvio il lavoro è chiuso: il runner riceve "lavoro scaduto"
    await jobs.failOpenLocalJobs();
    const expired = await call("POST", `/runner/jobs/${job.id}/heartbeat`, { token });
    expect(expired.status).toBe(410);
    expect(expired.json).toEqual({ error: "lavoro scaduto" });
  });

  it("mcpUrl usa PUBLIC_APP_URL se impostata", async () => {
    process.env["PUBLIC_APP_URL"] = "https://casello.example.com/qualcosa";
    try {
      const userId = await devUserId();
      const { machineId, token } = await registerMachine();
      const { fallbackAiModelId, runId } = await fixtures(userId);
      const job = await jobs.createLocalJob({ userId, machineId, kind: "run", runId, fallbackAiModelId, origin: "console" });
      const next = call("GET", "/runner/next", { token });
      expect(await jobs.awaitDispatch(job.id, signal())).toEqual({ kind: "local" });
      void jobs.runItem(job.id, { prompt: "p", resume: false }, signal()).catch(() => {});
    const res = await next;
      expect(res.json.mcpUrl).toBe("https://casello.example.com/api/mcp");
      await jobs.finishLocalJob(job.id, "completed");
    } finally {
      delete process.env["PUBLIC_APP_URL"];
    }
  });
});

describe("lavori dalla console", () => {
  it("GET /local/jobs: solo i propri aperti; POST choice applica la scelta", async () => {
    const userId = await devUserId();
    const { machineId } = await registerMachine();
    const { fallbackAiModelId, runId } = await fixtures(userId);
    const job = await jobs.createLocalJob({ userId, machineId, kind: "run", runId, fallbackAiModelId, origin: "console" });
    const closed = await jobs.createLocalJob({ userId, machineId, kind: "run", runId, fallbackAiModelId, origin: "console" });
    await jobs.finishLocalJob(closed.id, "completed");

    // Lavoro di un altro utente
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com" }).returning();
    const [otherMachine] = await db.insert(localMachinesTable).values({ userId: other!.id, name: "PC", tokenHash: hashToken("pc") }).returning();
    const foreign = await jobs.createLocalJob({ userId: other!.id, machineId: otherMachine!.id, kind: "run", runId, fallbackAiModelId, origin: "console" });

    const outcome = jobs.awaitDispatch(job.id, signal());
    for (let i = 0; i < 100; i++) {
      const [row] = await db.select().from(localJobsTable).where(eq(localJobsTable.id, job.id));
      if (row!.status === "waiting_choice") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const list = await call("GET", "/local/jobs");
    expect(list.status).toBe(200);
    expect(list.json).toEqual([
      {
        id: job.id,
        kind: "run",
        analysisId: null,
        runId,
        machineId,
        status: "waiting_choice",
        origin: "console",
        claimedBy: null,
        fallbackAiModelId,
        error: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);

    expect((await call("POST", `/local/jobs/${foreign.id}/choice`, { body: { choice: "fallback" } })).status).toBe(404);
    expect((await call("POST", `/local/jobs/${closed.id}/choice`, { body: { choice: "fallback" } })).status).toBe(409);
    expect((await call("POST", `/local/jobs/${job.id}/choice`, { body: { choice: "boh" } })).status).toBe(400);
    const chosen = await call("POST", `/local/jobs/${job.id}/choice`, { body: { choice: "fallback" } });
    expect(chosen.status, chosen.text).toBe(204);
    expect(await outcome).toEqual({ kind: "fallback", aiModelId: fallbackAiModelId });
    expect((await call("GET", "/local/jobs")).json).toEqual([]);
  });
});

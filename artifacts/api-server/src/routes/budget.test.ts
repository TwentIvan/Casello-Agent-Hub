import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  planConversationsTable,
  runsTable,
  usersTable,
} from "@workspace/db";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../test/fake-provider";
import { encryptSecret } from "../lib/secrets";
import { monthLabel, monthStart } from "../lib/budget";

// Tetti di spesa sull'app completa senza login (AUTH_DISABLED=true: l'utente corrente è dev@localhost).
// Run, analisi e conversazioni con un costo si inseriscono a mano; le run avviate davvero falliscono subito
// (il finto provider risponde 400). File a parte: il rate limit degli avvii (10/minuto) è per file.

let base: string;
let server: http.Server;
let fake: FakeProvider;

const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function devUserId(): Promise<number> {
  await api("GET", "/auth/me");
  const [u] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  return u!.id;
}

/** Account verso il finto provider (null = account di sistema), con un modello prezzato. */
async function modelOf(userId: number | null, name: string) {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId,
      name,
      provider: "custom",
      baseUrl: fake.baseUrl,
      allowPrivateNetwork: true,
      apiKeyEnc: encryptSecret("sk-test"),
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: `m-${name}`, displayName: name, priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  return model!.id;
}

async function createApp(): Promise<number> {
  const res = await api("POST", "/apps", { name: `App ${Math.random().toString(36).slice(2, 8)}`, baseUrl: "http://app.example.com" });
  expect(res.status, res.text).toBe(201);
  return res.json.id;
}

async function createAgent(appId: number, aiModelId: number | null): Promise<number> {
  const [agent] = await db.insert(agentsTable).values({ appId, name: "Area", aiModelId, status: "active" }).returning();
  return agent!.id;
}

const LAST_MONTH = new Date(Date.now() - 40 * 24 * 3600 * 1000);

async function addRun(
  agentId: number,
  aiModelId: number | null,
  costUsd: string | null,
  extra: Partial<typeof runsTable.$inferInsert> = {},
) {
  const [run] = await db
    .insert(runsTable)
    .values({ agentId, aiModelId, status: "succeeded", costUsd, promptTokens: 100, completionTokens: 10, ...extra })
    .returning();
  return run!.id;
}

async function settleRuns() {
  for (let i = 0; i < 500; i++) {
    const active = await db
      .select({ id: runsTable.id })
      .from(runsTable)
      .where(inArray(runsTable.status, ["pending", "running"]));
    if (!active.length) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run ancora attive dopo il test");
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "d".repeat(64);
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
  fake = await startFakeProvider({ statusFor: { chat: 400 } });
});

afterEach(async () => {
  // Le run "attive" inserite a mano non girano: si chiudono prima di attendere quelle avviate davvero
  await db
    .update(runsTable)
    .set({ status: "cancelled" })
    .where(inArray(runsTable.status, ["awaiting_client"]));
  await settleRuns();
  vi.restoreAllMocks();
  await fake.close();
});

let restoreLoopback: () => void;
beforeAll(() => {
  restoreLoopback = allowTestLoopback();
});
afterAll(() => restoreLoopback());

describe("mese di calendario (ora italiana)", () => {
  it("inizio del mese con l'ora legale e con l'ora solare", () => {
    expect(monthStart(new Date("2026-10-15T12:00:00Z")).toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(monthStart(new Date("2026-11-15T12:00:00Z")).toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(monthStart(new Date("2027-01-01T00:00:00Z")).toISOString()).toBe("2026-12-31T23:00:00.000Z");
  });

  it("a mezzanotte e mezza del primo a Roma è già il mese nuovo", () => {
    const at = new Date("2026-10-31T23:30:00Z");
    expect(monthLabel(at)).toBe("2026-11");
    expect(monthStart(at).toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });
});

describe("GET e PUT /budget", () => {
  it("senza tetti né spesa", async () => {
    const res = await api("GET", "/budget");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({
      month: monthLabel(),
      user: { capUsd: null, spentUsd: 0, unpricedCount: 0 },
      agents: [],
      activeRuns: [],
    });
  });

  it("imposta, arrotonda al centesimo e toglie il tetto dell'utente; negativo → 400", async () => {
    expect((await api("PUT", "/budget", { monthlyBudgetUsd: 12.344 })).json.user.capUsd).toBe(12.34);
    expect((await api("GET", "/budget")).json.user.capUsd).toBe(12.34);
    expect((await api("PUT", "/budget", { monthlyBudgetUsd: -1 })).status).toBe(400);
    expect((await api("PUT", "/budget", { monthlyBudgetUsd: null })).json.user.capUsd).toBeNull();
  });

  it("somma run, analisi e chat del mese sui propri account; esclude mese scorso, sistema e altri utenti", async () => {
    const dev = await devUserId();
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com" }).returning();
    const own = await modelOf(dev, "mio");
    const system = await modelOf(null, "sistema");
    const theirs = await modelOf(other!.id, "altrui");
    const appId = await createApp();
    const agentId = await createAgent(appId, own);

    await addRun(agentId, own, "1.5");
    await addRun(agentId, own, null); // senza prezzo
    await addRun(agentId, own, null, { promptTokens: null, completionTokens: null }); // mai partita: non conta
    await addRun(agentId, own, "100", { createdAt: LAST_MONTH });
    await addRun(agentId, system, "50");
    await addRun(agentId, theirs, "70");
    const [analysis] = await db
      .insert(analysesTable)
      .values({ appId, model: "m", aiModelId: own, sources: { code: "none", openapi: false, description: false }, maxTokens: 1000, tokensUsed: 10, costUsd: "0.25", status: "completed" })
      .returning();
    await db.insert(planConversationsTable).values([
      { appId, analysisId: analysis!.id, userId: dev, aiModelId: own, title: "a", tokensUsed: 5, costUsd: "0.25" },
      { appId, analysisId: analysis!.id, userId: dev, aiModelId: own, title: "b", tokensUsed: 5, costUsd: null },
    ]);

    const { json } = await api("GET", "/budget");
    expect(json.user).toEqual({ capUsd: null, spentUsd: 2, unpricedCount: 2 });
  });
});

describe("blocco degli avvii", () => {
  it("run: oltre il tetto dell'utente che paga il modello → 409 e nessuna run creata", async () => {
    const dev = await devUserId();
    const own = await modelOf(dev, "mio");
    const agentId = await createAgent(await createApp(), own);
    await addRun(agentId, own, "5");
    await api("PUT", "/budget", { monthlyBudgetUsd: 5 });

    const res = await api("POST", `/agents/${agentId}/runs`, { input: "ciao" });
    expect(res.status, res.text).toBe(409);
    expect(res.json.error).toBe(
      "Tetto di spesa mensile raggiunto: spesi 5,00 su 5,00 USD. Alzalo nella pagina Account o attendi il mese prossimo.",
    );
    expect(await db.select().from(runsTable)).toHaveLength(1);
  });

  it("run: sotto il tetto parte e ricorda il modello; il modello di sistema non conta nel tetto dell'utente", async () => {
    const dev = await devUserId();
    const own = await modelOf(dev, "mio");
    const system = await modelOf(null, "sistema");
    const appId = await createApp();
    const ownAgent = await createAgent(appId, own);
    const systemAgent = await createAgent(appId, system);
    await addRun(systemAgent, system, "500");
    await api("PUT", "/budget", { monthlyBudgetUsd: 5 });

    const res = await api("POST", `/agents/${ownAgent}/runs`, { input: "ciao" });
    expect(res.status, res.text).toBe(202);
    const [run] = await db.select().from(runsTable).where(eq(runsTable.id, res.json.id));
    expect(run!.aiModelId).toBe(own);
    expect((await api("POST", `/agents/${systemAgent}/runs`, { input: "ciao" })).status).toBe(202);
  });

  it("run: il tetto dell'agente conta tutte le sue run, anche sul vecchio gateway", async () => {
    const agentId = await createAgent(await createApp(), null);
    const patched = await api("PATCH", `/agents/${agentId}`, { monthlyBudgetUsd: 1 });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.json.monthlyBudgetUsd).toBe(1);
    await addRun(agentId, null, "0.6");
    await addRun(agentId, null, "0.4");

    const res = await api("POST", `/agents/${agentId}/runs`, { input: "ciao" });
    expect(res.status, res.text).toBe(409);
    expect(res.json.error).toContain("Tetto di spesa mensile dell'agente raggiunto: spesi 1,00 su 1,00 USD");

    const summary = (await api("GET", "/budget")).json;
    expect(summary.agents).toEqual([
      { agentId, agentName: "Area", appId: expect.any(Number), capUsd: 1, spentUsd: 1, unpricedCount: 0 },
    ]);
    expect((await api("PATCH", `/agents/${agentId}`, { monthlyBudgetUsd: null })).json.monthlyBudgetUsd).toBeNull();
  });

  it("analisi cloud bloccata oltre il tetto, analisi locale no", async () => {
    const dev = await devUserId();
    const own = await modelOf(dev, "mio");
    const appId = await createApp();
    await addRun(await createAgent(appId, own), own, "3");
    await api("PUT", "/budget", { monthlyBudgetUsd: 2 });

    const cloud = await api("POST", `/apps/${appId}/analyses`, { aiModelId: own });
    expect(cloud.status, cloud.text).toBe(409);
    expect(cloud.json.error).toContain("Tetto di spesa mensile raggiunto");
    const local = await api("POST", `/apps/${appId}/analyses`, { executor: "local" });
    expect(local.status, local.text).toBe(202);
  });

  it("chat del piano: messaggio bloccato oltre il tetto", async () => {
    const dev = await devUserId();
    const own = await modelOf(dev, "mio");
    const appId = await createApp();
    await addRun(await createAgent(appId, own), own, "3");
    const [analysis] = await db
      .insert(analysesTable)
      .values({ appId, model: "m", sources: { code: "none", openapi: false, description: false }, maxTokens: 1000, status: "completed" })
      .returning();
    const [conv] = await db
      .insert(planConversationsTable)
      .values({ appId, analysisId: analysis!.id, userId: dev, aiModelId: own, title: "" })
      .returning();
    await api("PUT", "/budget", { monthlyBudgetUsd: 2 });

    const res = await api("POST", `/plan-conversations/${conv!.id}/messages`, { content: "ciao" });
    expect(res.status, res.text).toBe(409);
    expect(res.json.error).toContain("Tetto di spesa mensile raggiunto");
  });
});

describe("modello della run", () => {
  it("l'esecuzione usa il modello fissato sulla run, non quello attuale dell'agente", async () => {
    const dev = await devUserId();
    const before = await modelOf(dev, "vecchio");
    const after = await modelOf(dev, "nuovo");
    const agentId = await createAgent(await createApp(), after);
    const runId = await addRun(agentId, before, null, { status: "pending", promptTokens: null, completionTokens: null });

    const { startRun } = await import("../lib/run-executor");
    await startRun(runId);
    const models = fake.requests.filter((r) => r.path.endsWith("/chat/completions")).map((r) => (r.body as { model: string }).model);
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models)).toEqual(new Set(["m-vecchio"]));
  });
});

describe("statistiche della dashboard", () => {
  it("conta a parte le run annullate", async () => {
    const agentId = await createAgent(await createApp(), null);
    await addRun(agentId, null, null);
    await addRun(agentId, null, null, { status: "cancelled" });
    const { json } = await api("GET", "/dashboard/stats");
    expect(json).toMatchObject({ totalRuns: 2, successfulRuns: 1, failedRuns: 0, cancelledRuns: 1 });
  });
});

describe("run da poter annullare", () => {
  it("elenca le run attive sui tetti raggiunti, non le altre", async () => {
    const dev = await devUserId();
    const own = await modelOf(dev, "mio");
    const system = await modelOf(null, "sistema");
    const appId = await createApp();
    const ownAgent = await createAgent(appId, own);
    const systemAgent = await createAgent(appId, system);
    const cappedAgent = await createAgent(appId, system);
    await db.update(agentsTable).set({ monthlyBudgetUsd: "1.00" }).where(eq(agentsTable.id, cappedAgent));

    const ownActive = await addRun(ownAgent, own, "4", { status: "awaiting_client" });
    await addRun(systemAgent, system, null, { status: "awaiting_client", promptTokens: null, completionTokens: null });
    const cappedActive = await addRun(cappedAgent, system, "2", { status: "awaiting_client" });

    expect((await api("GET", "/budget")).json.activeRuns.map((r: { id: number }) => r.id)).toEqual([cappedActive]);

    await api("PUT", "/budget", { monthlyBudgetUsd: 3 });
    const { json } = await api("GET", "/budget");
    expect(json.activeRuns).toEqual([
      { id: ownActive, agentId: ownAgent, agentName: "Area", status: "awaiting_client" },
      { id: cappedActive, agentId: cappedAgent, agentName: "Area", status: "awaiting_client" },
    ]);
  });
});

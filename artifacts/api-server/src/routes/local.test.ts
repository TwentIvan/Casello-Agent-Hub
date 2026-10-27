import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  localMachinesTable,
  mcpTokensTable,
  usersTable,
} from "@workspace/db";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../test/fake-provider";
import { ensureProviderRegistry } from "../lib/catalog/provider-registry";
import { hashToken } from "../lib/local/tokens";
import { encryptSecret } from "../lib/secrets";

// Agente locale dalla console: macchine (ognuna è un modello "Agente locale · <nome>"), token personali e
// modello di riserva obbligatorio negli agenti e nelle analisi. App completa senza login (AUTH_DISABLED=true:
// l'utente corrente è dev@localhost); il secondo utente e i suoi dati si inseriscono a mano nel DB.

const KEY = "sk-CHIAVE-DELL-UTENTE-DEV-44";

let base: string;
let server: http.Server;
let fake: FakeProvider;
let bodies: string[] = [];
let isLocalModel: (aiModelId: number) => Promise<{ machineId: number } | null>;

const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY", "AI_GATEWAY_BASE_URL", "AI_GATEWAY_API_KEY"] as const;
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
  bodies.push(text);
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function devUserId(): Promise<number> {
  await api("GET", "/auth/me");
  const [u] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  return u!.id;
}

async function otherUser() {
  const [user] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
  return user!;
}

/** Account `custom` verso il finto provider, con un modello API prezzato. */
async function apiModelFor(userId: number, modelId = "fake-model") {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId,
      name: `Account ${userId}`,
      provider: "custom",
      baseUrl: fake.baseUrl,
      allowPrivateNetwork: true,
      apiKeyEnc: encryptSecret(KEY),
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId, displayName: modelId, priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  return model!;
}

async function createApp() {
  const res = await api("POST", "/apps", { name: `App ${Math.random().toString(36).slice(2, 8)}`, baseUrl: fake.baseUrl.replace(/\/v1$/, "") });
  expect(res.status, res.text).toBe(201);
  return res.json as { id: number };
}

/** Registra una macchina dell'utente corrente e restituisce macchina, token e id del suo modello. */
async function registerMachine(name = "MacBook") {
  const res = await api("POST", "/local/machines", { name });
  expect(res.status, res.text).toBe(201);
  const aiModelId = await machineModelId(res.json.machine.id);
  return { machine: res.json.machine, token: res.json.token as string, aiModelId };
}

async function machineModelId(machineId: number): Promise<number> {
  const [row] = await db
    .select({ id: aiModelsTable.id })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .where(and(eq(aiAccountsTable.provider, "local_agent"), eq(aiModelsTable.modelId, `machine-${machineId}`)));
  return row!.id;
}

/** Macchina e modello di un altro utente, inseriti a mano. */
async function otherUsersMachine() {
  const other = await otherUser();
  const [machine] = await db.insert(localMachinesTable).values({ userId: other.id, name: "PC altrui", tokenHash: hashToken("x") }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: other.id, name: "Agente locale", provider: "local_agent", baseUrl: "local://", status: "ok" })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: `machine-${machine!.id}`, displayName: "Agente locale · PC altrui", supportsTools: true, availability: "available" })
    .returning();
  return { other, machine: machine!, aiModelId: model!.id };
}

async function settleAnalyses() {
  for (let i = 0; i < 500; i++) {
    const active = await db.select({ id: analysesTable.id }).from(analysesTable).where(inArray(analysesTable.status, ["queued", "running"]));
    if (!active.length) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("analisi ancora attive dopo il test");
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "c".repeat(64);
  delete process.env["AI_GATEWAY_BASE_URL"];
  delete process.env["AI_GATEWAY_API_KEY"];
  await ensureProviderRegistry();
  ({ isLocalModel } = await import("../lib/local/machines"));
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
  bodies = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  fake = await startFakeProvider({ statusFor: { chat: 400 } });
});

afterEach(async () => {
  await settleAnalyses();
  vi.restoreAllMocks();
  await fake.close();
  for (const text of bodies) expect(text).not.toContain(KEY);
});

let restoreLoopback: () => void;
beforeAll(() => {
  restoreLoopback = allowTestLoopback();
});
afterAll(() => restoreLoopback());

describe("macchine dell'agente locale", () => {
  it("registrazione: token csl_m_ una sola volta (salvato come hash), account e modello 'Agente locale · MacBook'", async () => {
    const dev = await devUserId();
    const { machine, token, aiModelId } = await registerMachine("MacBook");
    expect(token).toMatch(/^csl_m_[A-Za-z0-9_-]{43}$/);
    expect(machine).toEqual({ id: expect.any(Number), name: "MacBook", connected: false, lastSeenAt: null, revokedAt: null });

    const [row] = await db.select().from(localMachinesTable).where(eq(localMachinesTable.id, machine.id));
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(row!.userId).toBe(dev);

    const list = await api("GET", "/local/machines");
    expect(list.status).toBe(200);
    expect(list.json).toEqual([machine]);
    expect(list.text).not.toContain(token);
    expect(list.text).not.toContain(row!.tokenHash);

    const models = await api("GET", "/ai/models");
    const group = models.json.find((g: { account: { provider: string } }) => g.account.provider === "local_agent");
    expect(group.account).toMatchObject({ name: "Agente locale", keySet: false, isDefault: false, status: "ok" });
    expect(group.models).toEqual([
      expect.objectContaining({ id: aiModelId, modelId: `machine-${machine.id}`, displayName: "Agente locale · MacBook", selectable: true, recommended: false, supportsTools: true }),
    ]);
    expect(await isLocalModel(aiModelId)).toEqual({ machineId: machine.id });
  });

  it("una seconda macchina riusa lo stesso account; il consigliato non è mai un modello locale", async () => {
    const dev = await devUserId();
    await apiModelFor(dev, "api-model");
    await registerMachine("MacBook");
    await registerMachine("Fisso");
    const accounts = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.provider, "local_agent"));
    expect(accounts).toHaveLength(1);

    const models = await api("GET", "/ai/models");
    const local = models.json.find((g: { account: { provider: string } }) => g.account.provider === "local_agent");
    expect(local.models.map((m: { displayName: string }) => m.displayName)).toEqual(["Agente locale · Fisso", "Agente locale · MacBook"]);
    expect(local.models.every((m: { recommended: boolean }) => !m.recommended)).toBe(true);
    const apiGroup = models.json.find((g: { account: { provider: string } }) => g.account.provider === "custom");
    expect(apiGroup.models[0].recommended).toBe(true);
  });

  it("connected: vero solo con un segnale di vita negli ultimi 30 s", async () => {
    const a = await registerMachine("A");
    const b = await registerMachine("B");
    await db.update(localMachinesTable).set({ lastSeenAt: new Date(Date.now() - 5_000) }).where(eq(localMachinesTable.id, a.machine.id));
    await db.update(localMachinesTable).set({ lastSeenAt: new Date(Date.now() - 60_000) }).where(eq(localMachinesTable.id, b.machine.id));
    const list = await api("GET", "/local/machines");
    const byName = Object.fromEntries(list.json.map((m: { name: string; connected: boolean }) => [m.name, m.connected]));
    expect(byName).toEqual({ A: true, B: false });
  });

  it("revoca: macchina revocata, modello nascosto e non più selezionabile", async () => {
    await devUserId();
    const { machine, aiModelId } = await registerMachine("MacBook");
    const del = await api("DELETE", `/local/machines/${machine.id}`);
    expect(del.status).toBe(204);

    const list = await api("GET", "/local/machines");
    expect(list.json[0].revokedAt).not.toBeNull();
    const [model] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.id, aiModelId));
    expect(model!.hidden).toBe(true);
    const models = await api("GET", "/ai/models");
    expect(JSON.stringify(models.json)).not.toContain("Agente locale · MacBook");

    const app = await createApp();
    const res = await api("POST", "/agents", { appId: app.id, name: "Area", aiModelId });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "modello non disponibile" });
  });

  it("macchine di un altro utente: invisibili, non revocabili (404), modello non selezionabile", async () => {
    await devUserId();
    const { machine, aiModelId } = await otherUsersMachine();
    expect((await api("GET", "/local/machines")).json).toEqual([]);
    const del = await api("DELETE", `/local/machines/${machine.id}`);
    expect(del.status).toBe(404);
    const [row] = await db.select().from(localMachinesTable).where(eq(localMachinesTable.id, machine.id));
    expect(row!.revokedAt).toBeNull();
    expect(JSON.stringify((await api("GET", "/ai/models")).json)).not.toContain("PC altrui");

    const app = await createApp();
    const res = await api("POST", "/agents", { appId: app.id, name: "Area", aiModelId });
    expect(res.status).toBe(400);
  });

  it("nome vuoto o con caratteri di controllo → 400", async () => {
    expect((await api("POST", "/local/machines", { name: "  " })).status).toBe(400);
    expect((await api("POST", "/local/machines", { name: "a\u0007b" })).status).toBe(400);
  });
});

describe("account dell'agente locale nelle route generiche", () => {
  it("POST /ai/accounts con local_agent → 400; /ai/providers non lo elenca", async () => {
    const res = await api("POST", "/ai/accounts", { name: "Locale", provider: "local_agent", apiKey: "x" });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "provider non ammesso: l'agente locale si collega dalla sezione Agenti locali" });
    const providers = await api("GET", "/ai/providers");
    expect(providers.json.map((p: { slug: string }) => p.slug)).not.toContain("local_agent");
  });

  it("modifica, verifica, eliminazione, predefinito e modelli dell'account locale → 400", async () => {
    await devUserId();
    const { aiModelId } = await registerMachine();
    const [account] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.provider, "local_agent"));
    const id = account!.id;
    for (const [method, path, body] of [
      ["PATCH", `/ai/accounts/${id}`, { name: "x" }],
      ["POST", `/ai/accounts/${id}/verify`, undefined],
      ["DELETE", `/ai/accounts/${id}`, undefined],
      ["POST", `/ai/accounts/${id}/default`, undefined],
      ["POST", `/ai/accounts/${id}/models`, { modelId: "machine-999" }],
      ["PATCH", `/ai/models/${aiModelId}`, { hidden: false }],
      ["POST", `/ai/models/${aiModelId}/probe`, undefined],
    ] as const) {
      const res = await api(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(res.json).toEqual({ error: "account dell'agente locale: si gestisce dalla sezione Agenti locali" });
    }
    expect(await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, id))).toHaveLength(1);
  });
});

describe("modello di riserva negli agenti", () => {
  it("modello locale senza riserva → 400 col messaggio; riserva locale → 400; riserva altrui → 400", async () => {
    await devUserId();
    const { aiModelId } = await registerMachine();
    const { aiModelId: second } = await registerMachine("Fisso");
    const other = await otherUser();
    const othersModel = await apiModelFor(other.id);
    const app = await createApp();

    const none = await api("POST", "/agents", { appId: app.id, name: "Area", aiModelId });
    expect(none.status).toBe(400);
    expect(none.json).toEqual({ error: "modello di riserva obbligatorio con l'agente locale" });

    const local = await api("POST", "/agents", { appId: app.id, name: "Area", aiModelId, fallbackAiModelId: second });
    expect(local.status).toBe(400);
    expect(local.json).toEqual({ error: "il modello di riserva deve essere un modello API" });

    const foreign = await api("POST", "/agents", { appId: app.id, name: "Area", aiModelId, fallbackAiModelId: othersModel.id });
    expect(foreign.status).toBe(400);
    expect(foreign.json).toEqual({ error: "modello non disponibile" });
    expect(await db.select().from(agentsTable).where(eq(agentsTable.name, "Area"))).toHaveLength(0);
  });

  it("modello locale con riserva propria: salvati riserva, regola, attesa e utenti terzi", async () => {
    const dev = await devUserId();
    const { aiModelId } = await registerMachine();
    const fallback = await apiModelFor(dev);
    const app = await createApp();

    const res = await api("POST", "/agents", {
      appId: app.id,
      name: "Area",
      aiModelId,
      fallbackAiModelId: fallback.id,
      localOfflinePolicy: "wait_then_fallback",
      localOfflineWaitS: 120,
      localForThirdParties: true,
    });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({
      aiModelId,
      fallbackAiModelId: fallback.id,
      localOfflinePolicy: "wait_then_fallback",
      localOfflineWaitS: 120,
      localForThirdParties: true,
    });

    // Default della regola per un agente qualsiasi
    const plain = await api("POST", "/agents", { appId: app.id, name: "API", aiModelId: fallback.id });
    expect(plain.json).toMatchObject({ fallbackAiModelId: null, localOfflinePolicy: "fallback", localOfflineWaitS: 30, localForThirdParties: false });
  });

  it("attesa fuori da 1–600 → 400", async () => {
    const dev = await devUserId();
    const { aiModelId } = await registerMachine();
    const fallback = await apiModelFor(dev);
    const app = await createApp();
    for (const localOfflineWaitS of [0, 601]) {
      const res = await api("POST", "/agents", { appId: app.id, name: "Area", aiModelId, fallbackAiModelId: fallback.id, localOfflineWaitS });
      expect(res.status).toBe(400);
    }
  });

  it("PATCH verso un modello locale senza riserva → 400; con riserva → 200; togliere la riserva → 400", async () => {
    const dev = await devUserId();
    const { aiModelId } = await registerMachine();
    const fallback = await apiModelFor(dev);
    const app = await createApp();
    const created = await api("POST", "/agents", { appId: app.id, name: "Area", aiModelId: fallback.id });
    const id = created.json.id;

    const ko = await api("PATCH", `/agents/${id}`, { aiModelId });
    expect(ko.status).toBe(400);
    expect(ko.json).toEqual({ error: "modello di riserva obbligatorio con l'agente locale" });

    const ok = await api("PATCH", `/agents/${id}`, { aiModelId, fallbackAiModelId: fallback.id, localOfflineWaitS: 600 });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({ aiModelId, fallbackAiModelId: fallback.id, localOfflineWaitS: 600 });

    const removed = await api("PATCH", `/agents/${id}`, { fallbackAiModelId: null });
    expect(removed.status).toBe(400);

    const renamed = await api("PATCH", `/agents/${id}`, { name: "Rinominato" });
    expect(renamed.status, renamed.text).toBe(200);
  });
});

describe("modello di riserva nelle analisi", () => {
  it("modello locale senza riserva → 400; riserva locale → 400; con riserva propria → 202 e salvata", async () => {
    const dev = await devUserId();
    const { aiModelId } = await registerMachine();
    const { aiModelId: second } = await registerMachine("Fisso");
    const fallback = await apiModelFor(dev);
    const app = await createApp();

    const none = await api("POST", `/apps/${app.id}/analyses`, { aiModelId });
    expect(none.status).toBe(400);
    expect(none.json).toEqual({ error: "modello di riserva obbligatorio con l'agente locale" });

    const local = await api("POST", `/apps/${app.id}/analyses`, { aiModelId, fallbackAiModelId: second });
    expect(local.status).toBe(400);
    expect(local.json).toEqual({ error: "il modello di riserva deve essere un modello API" });

    const ok = await api("POST", `/apps/${app.id}/analyses`, { aiModelId, fallbackAiModelId: fallback.id });
    expect(ok.status, ok.text).toBe(202);
    expect(ok.json.fallbackAiModelId).toBe(fallback.id);
    const [row] = await db.select().from(analysesTable).where(eq(analysesTable.id, ok.json.id));
    expect(row!.fallbackAiModelId).toBe(fallback.id);
  });

  it("zip con modello locale senza riserva → 400", async () => {
    await devUserId();
    const { aiModelId } = await registerMachine();
    const app = await createApp();
    const res = await fetch(`${base}/api/apps/${app.id}/analyses/zip?aiModelId=${aiModelId}`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "modello di riserva obbligatorio con l'agente locale" });
  });
});

describe("token personali", () => {
  it("creato (csl_p_, una sola volta), elencato senza valore, revocato", async () => {
    const dev = await devUserId();
    const created = await api("POST", "/local/tokens", { name: "Claude Desktop" });
    expect(created.status, created.text).toBe(201);
    const token = created.json.token as string;
    expect(token).toMatch(/^csl_p_[A-Za-z0-9_-]{43}$/);
    expect(created.json.personalToken).toEqual({ id: expect.any(Number), name: "Claude Desktop", lastUsedAt: null, revokedAt: null, createdAt: expect.any(String) });
    const [row] = await db.select().from(mcpTokensTable).where(eq(mcpTokensTable.id, created.json.personalToken.id));
    expect(row).toMatchObject({ userId: dev, tokenHash: hashToken(token) });

    const list = await api("GET", "/local/tokens");
    expect(list.json).toEqual([created.json.personalToken]);
    expect(list.text).not.toContain(token);

    expect((await api("DELETE", `/local/tokens/${row!.id}`)).status).toBe(204);
    const after = await api("GET", "/local/tokens");
    expect(after.json[0].revokedAt).not.toBeNull();
  });

  it("token di un altro utente: invisibile e non revocabile (404)", async () => {
    await devUserId();
    const other = await otherUser();
    const [row] = await db.insert(mcpTokensTable).values({ userId: other.id, name: "Suo", tokenHash: hashToken("y") }).returning();
    expect((await api("GET", "/local/tokens")).json).toEqual([]);
    expect((await api("DELETE", `/local/tokens/${row!.id}`)).status).toBe(404);
  });
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, notInArray } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  appsTable,
  modelCatalogTable,
  providersTable,
  usersTable,
} from "@workspace/db";
import { allowTestLoopback, FAKE_PROVIDER_ERROR_TEXT, startFakeProvider, type FakeProvider } from "../../test/fake-provider";
import { encryptSecret } from "../lib/secrets";
import { ensureProviderRegistry } from "../lib/catalog/provider-registry";

// API degli account AI su un'app Express vera (porta 0), senza login (AUTH_DISABLED=true: utente di
// sviluppo). Il secondo utente e i suoi account si inseriscono a mano nel DB. La scoperta dei modelli
// passa dal finto provider (http://127.0.0.1…): per questo gli account di prova sono `custom` con
// allowPrivateNetwork. Il router di prova ha un rate limit che non scatta; quello vero si prova
// sull'app completa in fondo.

const KEY = "sk-CHIAVE-SEGRETISSIMA-42";
const KEY2 = "sk-ALTRA-CHIAVE-SEGRETA-77";
const OTHER_KEY = "sk-CHIAVE-DELL-ALTRO-UTENTE";
const SYSTEM_MESSAGE = "account di sistema non modificabile";

const realFetch = globalThis.fetch;

let base: string;
let fullBase: string;
let server: http.Server;
let fullServer: http.Server;
let fake: FakeProvider;
let ensureSystemAccount: () => Promise<{ accountId: number } | null>;

const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY", "AI_GATEWAY_BASE_URL", "AI_GATEWAY_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

/** Tutti i corpi delle risposte: nessuno deve contenere una chiave. */
let bodies: string[] = [];

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

function close(s: http.Server): Promise<void> {
  return new Promise((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown, root = base): Promise<{ status: number; text: string; json: any }> {
  const res = await realFetch(`${root}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

function customInput(over: Record<string, unknown> = {}) {
  return { name: "Locale", provider: "custom", apiKey: KEY, baseUrl: fake.baseUrl, allowPrivateNetwork: true, ...over };
}

async function createAccount(over: Record<string, unknown> = {}) {
  const res = await api("POST", "/ai/accounts", customInput(over));
  expect(res.status, res.text).toBe(201);
  return res.json as { id: number; isDefault: boolean; [k: string]: unknown };
}

async function modelsOf(accountId: number) {
  return db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, accountId)).orderBy(aiModelsTable.modelId);
}

async function devUserId(): Promise<number> {
  const [u] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  return u!.id;
}

/** Secondo utente con un suo account e un modello, inseriti a mano. */
async function otherUserAccount() {
  const [user] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId: user!.id,
      name: "Account dell'altro",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnc: encryptSecret(OTHER_KEY),
      isDefault: true,
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "deepseek-chat", displayName: "DeepSeek", priceInputPerMtok: "0.28", priceOutputPerMtok: "0.42" })
    .returning();
  return { user: user!, account: account!, model: model! };
}

let appSeq = 0;
async function newApp() {
  appSeq += 1;
  const [app] = await db.insert(appsTable).values({ name: `App ${appSeq}`, slug: `app-${appSeq}`, baseUrl: "https://app.example.com" }).returning();
  return app!;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  process.env["AI_GATEWAY_BASE_URL"] = "http://gateway.interno:4000/v1";
  process.env["AI_GATEWAY_API_KEY"] = "sk-gateway-di-sistema";

  const { requireAuth } = await import("../lib/auth");
  const { createAiRouter } = await import("./ai");
  const { errorHandler } = await import("../middlewares/error-handler");
  ({ ensureSystemAccount } = await import("../lib/ai/system-account"));
  const noLimit: RequestHandler = (_req, _res, next) => next();
  const mini = express();
  mini.use(express.json());
  mini.use("/api", requireAuth, createAiRouter({ providerRateLimit: noLimit, probeRateLimit: noLimit }));
  mini.use("/api", errorHandler);
  server = http.createServer(mini);
  base = `http://127.0.0.1:${await listen(server)}`;

  const { default: app } = await import("../app");
  fullServer = http.createServer(app);
  fullBase = `http://127.0.0.1:${await listen(fullServer)}`;
});

afterAll(async () => {
  await close(server);
  await close(fullServer);
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  bodies = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users, apps, ai_accounts, model_catalog RESTART IDENTITY CASCADE");
  fake = await startFakeProvider({
    apiKey: KEY,
    models: [
      { id: "modello-a", name: "Modello A", context_length: 32_768, pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "modello-b" },
    ],
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fake.close();
  // Nessuna chiave in nessuna risposta del test
  for (const text of bodies) {
    for (const secret of [KEY, KEY2, OTHER_KEY, "sk-gateway-di-sistema"]) expect(text).not.toContain(secret);
    expect(text).not.toContain("apiKeyEnc");
    expect(text).not.toContain(FAKE_PROVIDER_ERROR_TEXT);
  }
});

// Il finto provider ascolta su 127.0.0.1: deroga dei test al divieto del loopback (vedi allowTestLoopback)
let restoreLoopback: () => void;
beforeAll(() => {
  restoreLoopback = allowTestLoopback();
});
afterAll(() => restoreLoopback());

describe("creazione", () => {
  it("crea e verifica: modelli salvati, chiave cifrata e mai esposta, primo account predefinito", async () => {
    const res = await api("POST", "/ai/accounts", customInput());
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({
      name: "Locale",
      provider: "custom",
      baseUrl: fake.baseUrl,
      allowPrivateNetwork: true,
      isDefault: true,
      status: "ok",
      lastError: null,
      keySet: true,
      isSystem: false,
      modelCount: 2,
    });
    expect(res.json.lastCheckedAt).toEqual(expect.any(String));
    expect(res.json).not.toHaveProperty("apiKey");
    expect(fake.requests[0]).toMatchObject({ path: "/v1/models", authorization: `Bearer ${KEY}` });

    const { rows } = await pool.query("select api_key_enc from ai_accounts where id = $1", [res.json.id]);
    expect(rows[0].api_key_enc).toMatch(/^v1:/);
    expect(rows[0].api_key_enc).not.toContain(KEY);

    const models = await modelsOf(res.json.id);
    expect(models.map((m) => [m.modelId, m.displayName, m.contextTokens, m.priceInputPerMtok, m.priceOutputPerMtok, m.priceSource, m.discovered])).toEqual([
      ["modello-a", "Modello A", 32_768, "1.000000", "2.000000", "provider", true],
      ["modello-b", "modello-b", null, null, null, null, true],
    ]);

    const list = await api("GET", "/ai/accounts");
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ id: res.json.id, keySet: true });
    const ms = await api("GET", `/ai/accounts/${res.json.id}/models`);
    expect(ms.status).toBe(200);
    expect(ms.json[0]).toEqual({
      id: expect.any(Number),
      accountId: res.json.id,
      modelId: "modello-a",
      displayName: "Modello A",
      contextTokens: 32_768,
      priceInput: 1,
      priceOutput: 2,
      priceSource: "provider",
      hidden: false,
      availability: "unknown",
      supportsTools: null,
      status: "available",
      deprecationDate: null,
      releasedAt: null,
      selectable: true,
      recommended: false,
      lastProbeAt: null,
      lastProbeOk: null,
    });
  });

  it("errore del provider → 400 con il messaggio fisso e nulla di salvato", async () => {
    fake.apiKey = "un'altra";
    let res = await api("POST", "/ai/accounts", customInput());
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "chiave non valida o senza permessi" });
    fake.apiKey = KEY;
    fake.status = 402;
    res = await api("POST", "/ai/accounts", customInput());
    expect(res.json).toEqual({ error: "credito del provider esaurito: ricarica il conto o scegli un altro modello" });
    fake.status = 500;
    res = await api("POST", "/ai/accounts", customInput());
    expect(res.json).toEqual({ error: "provider non raggiungibile" });
    expect(await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.provider, "custom"))).toHaveLength(0);
  });

  it("provider senza elenco dei modelli → account salvato, ok e senza modelli", async () => {
    fake.models = null;
    const acc = await createAccount();
    expect(acc).toMatchObject({ status: "ok", modelCount: 0, lastError: null });
  });

  it("regole sul provider, base URL, consenso e chiave", async () => {
    const cases: [Record<string, unknown>, string | RegExp][] = [
      [{ provider: "deepseek" }, /allowPrivateNetwork/],
      [{ provider: "system_gateway", allowPrivateNetwork: false, baseUrl: null }, /sistema/],
      [{ baseUrl: null }, /base URL/],
      [{ baseUrl: "   " }, /base URL/],
      [{ allowPrivateNetwork: false }, "indirizzo non consentito"],
      [{ baseUrl: "ftp://x.example.com" }, "indirizzo non consentito"],
      [{ provider: "deepseek", allowPrivateNetwork: false, baseUrl: "https://altro.example.com/v1" }, /base URL/],
      [{ provider: "deepseek", allowPrivateNetwork: false, baseUrl: null, apiKey: "  " }, /chiave/],
      [{ provider: "openrouter", allowPrivateNetwork: false, baseUrl: null, apiKey: null }, /chiave/],
      [{ name: "" }, /name/],
    ];
    for (const [over, msg] of cases) {
      const res = await api("POST", "/ai/accounts", customInput(over));
      expect(res.status, JSON.stringify(over)).toBe(400);
      if (typeof msg === "string") expect(res.json.error).toBe(msg);
      else expect(res.json.error).toMatch(msg);
    }
    expect(fake.requests).toHaveLength(0);
    expect(await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.provider, "custom"))).toHaveLength(0);
  });

  it("custom senza chiave è ammesso (chiave vuota = nessuna)", async () => {
    fake.apiKey = null;
    const acc = await createAccount({ apiKey: "   " });
    expect(acc.keySet).toBe(false);
    expect(fake.requests[0]!.authorization).toBeUndefined();
  });

  it("provider noto: base URL predefinito, chiave ripulita, prezzi seed", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ data: [{ id: "deepseek-chat" }] });
    }) as typeof fetch);
    const res = await api("POST", "/ai/accounts", { name: "DeepSeek", provider: "deepseek", apiKey: `  ${KEY}  `, baseUrl: "https://api.deepseek.com/v1/" });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", allowPrivateNetwork: false });
    expect(calls).toEqual([{ url: "https://api.deepseek.com/v1/models", auth: `Bearer ${KEY}` }]);
    const [m] = await modelsOf(res.json.id);
    expect(m).toMatchObject({ modelId: "deepseek-chat", priceSource: "seed" });
    expect(m!.priceInputPerMtok).not.toBeNull();
  });
});

describe("provider del registro", () => {
  // I provider di oggi, già in docs/schema-casello.sql: alla fine restano solo loro (DB di prova condiviso)
  const TODAY = ["deepseek", "openrouter", "huggingface", "mistral", "groq", "together", "gemini", "custom", "system_gateway"];
  const UNMANAGED = "test-non-gestito";
  beforeAll(async () => {
    await ensureProviderRegistry();
    await db.insert(providersTable).values({
      slug: UNMANAGED,
      name: "Non gestito di prova",
      protocol: "unknown",
      status: "unmanaged",
      origin: "discovered",
      sourceKeys: { litellm: ["test_non_gestito"], openrouterAuthor: null },
    });
  });
  afterAll(async () => {
    // Prima gli account (chiave esterna verso providers), poi i provider aggiunti
    await pool.query("TRUNCATE ai_accounts RESTART IDENTITY CASCADE");
    await db.delete(providersTable).where(notInArray(providersTable.slug, TODAY));
  });

  it("elenco: gestiti per nome, poi in arrivo, poi non gestiti; senza system_gateway", async () => {
    const res = await api("GET", "/ai/providers");
    expect(res.status, res.text).toBe(200);
    const list = res.json as { slug: string; name: string; status: string }[];
    expect(list.map((p) => p.slug)).not.toContain("system_gateway");
    const statuses = list.map((p) => p.status);
    const firstComing = statuses.indexOf("coming");
    const firstUnmanaged = statuses.indexOf("unmanaged");
    expect(firstComing).toBeGreaterThan(0);
    expect(firstUnmanaged).toBeGreaterThan(firstComing);
    expect(statuses.slice(0, firstComing).every((s) => s === "managed")).toBe(true);
    expect(statuses.slice(firstComing, firstUnmanaged).every((s) => s === "coming")).toBe(true);
    expect(statuses.slice(firstUnmanaged).every((s) => s === "unmanaged")).toBe(true);
    const managedNames = list.slice(0, firstComing).map((p) => p.name);
    expect(managedNames).toEqual([...managedNames].sort((a, b) => a.localeCompare(b, "it")));

    const bySlug = new Map(list.map((p) => [p.slug, p]));
    expect(bySlug.get("deepseek")).toEqual({
      slug: "deepseek",
      name: "DeepSeek",
      protocol: "openai_compatible",
      status: "managed",
      defaultBaseUrl: "https://api.deepseek.com/v1",
      editableBaseUrl: false,
    });
    expect(bySlug.get("custom")).toMatchObject({ status: "managed", defaultBaseUrl: null, editableBaseUrl: true });
    expect(bySlug.get("perplexity")).toMatchObject({ status: "managed", defaultBaseUrl: null, editableBaseUrl: true });
    expect(bySlug.get("bedrock")).toMatchObject({ protocol: "bedrock", status: "coming", editableBaseUrl: false });
    expect(bySlug.get(UNMANAGED)).toMatchObject({ protocol: "unknown", status: "unmanaged", editableBaseUrl: true });
  });

  it("provider sconosciuto o con protocollo senza esecutore → 400 col messaggio fisso", async () => {
    let res = await api("POST", "/ai/accounts", customInput({ provider: "inesistente", allowPrivateNetwork: false, baseUrl: null }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "provider sconosciuto" });
    res = await api("POST", "/ai/accounts", customInput({ provider: "bedrock", allowPrivateNetwork: false, baseUrl: null }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "esecutore non ancora disponibile per questo provider" });
    expect(fake.requests).toHaveLength(0);
    expect(await db.select().from(aiAccountsTable)).toHaveLength(0);
  });

  it("provider non gestito: indirizzo obbligatorio; con l'indirizzo e il consenso → 201 e modelli scoperti", async () => {
    let res = await api("POST", "/ai/accounts", customInput({ provider: UNMANAGED, baseUrl: null }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "provider non gestito: inserisci l'indirizzo compatibile OpenAI" });
    expect(fake.requests).toHaveLength(0);

    res = await api("POST", "/ai/accounts", customInput({ provider: UNMANAGED }));
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({ provider: UNMANAGED, baseUrl: fake.baseUrl, allowPrivateNetwork: true, modelCount: 2 });
    expect((await modelsOf(res.json.id)).map((m) => m.modelId)).toEqual(["modello-a", "modello-b"]);

    // Modifica: indirizzo e consenso restano modificabili come per custom
    const other = await startFakeProvider({ apiKey: KEY, models: [{ id: "modello-c" }] });
    try {
      const upd = await api("PATCH", `/ai/accounts/${res.json.id}`, { baseUrl: other.baseUrl });
      expect(upd.status, upd.text).toBe(200);
      expect(upd.json).toMatchObject({ baseUrl: other.baseUrl, allowPrivateNetwork: true });
    } finally {
      await other.close();
    }
  });

  it("provider gestito senza indirizzo predefinito: indirizzo obbligatorio, solo https, niente rete privata", async () => {
    const input = { name: "Perplexity", provider: "perplexity", apiKey: KEY };
    let res = await api("POST", "/ai/accounts", input);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/base URL/);
    res = await api("POST", "/ai/accounts", { ...input, baseUrl: fake.baseUrl, allowPrivateNetwork: true });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/allowPrivateNetwork/);
    res = await api("POST", "/ai/accounts", { ...input, baseUrl: fake.baseUrl });
    expect(res.json).toEqual({ error: "indirizzo non consentito" });
    expect(fake.requests).toHaveLength(0);

    vi.stubGlobal("fetch", (async () => Response.json({ data: [{ id: "sonar" }] })) as typeof fetch);
    res = await api("POST", "/ai/accounts", { ...input, baseUrl: "https://api.perplexity.ai/v1/" });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({ provider: "perplexity", baseUrl: "https://api.perplexity.ai/v1", allowPrivateNetwork: false, modelCount: 1 });
  });
});

describe("predefinito", () => {
  it("il primo account è predefinito, il secondo no; /default sposta il predefinito", async () => {
    const a = await createAccount({ name: "A" });
    const b = await createAccount({ name: "B" });
    expect(a.isDefault).toBe(true);
    expect(b.isDefault).toBe(false);
    const res = await api("POST", `/ai/accounts/${b.id}/default`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: b.id, isDefault: true });
    const defaults = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.isDefault, true));
    expect(defaults.map((d) => d.id)).toEqual([b.id]);
    // Idempotente
    expect((await api("POST", `/ai/accounts/${b.id}/default`)).status).toBe(200);
  });

  it("scegliere il proprio predefinito non tocca quello di un altro utente", async () => {
    const other = await otherUserAccount();
    const a = await createAccount({ name: "A" });
    const b = await createAccount({ name: "B" });
    expect((await api("POST", `/ai/accounts/${b.id}/default`)).status).toBe(200);
    const defaults = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.isDefault, true)).orderBy(aiAccountsTable.id);
    expect(defaults.map((d) => d.id)).toEqual([other.account.id, b.id]);
    expect(a.isDefault).toBe(true);
  });
});

describe("verifica", () => {
  it("aggiunge i nuovi, aggiorna gli esistenti (non il nome), rispetta i prezzi manuali e non toglie i mancanti", async () => {
    const acc = await createAccount();
    const before = await modelsOf(acc.id);
    // Prezzo manuale e rinomina su modello-a
    await api("PATCH", `/ai/models/${before[0]!.id}`, { priceInput: 5, displayName: "Il mio modello" });
    fake.models = [
      { id: "modello-a", name: "Modello A2", context_length: 65_536, pricing: { prompt: "0.000003", completion: "0.000004" } },
      { id: "modello-b", name: "Modello B dal provider" },
      { id: "modello-c", name: "Modello C", pricing: { prompt: "0.0000001", completion: "0.0000002" } },
    ];
    const res = await api("POST", `/ai/accounts/${acc.id}/verify`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "ok", lastError: null, modelCount: 3 });
    const after = await modelsOf(acc.id);
    expect(after.map((m) => [m.modelId, m.displayName, m.contextTokens, m.priceInputPerMtok, m.priceSource, m.discovered])).toEqual([
      ["modello-a", "Il mio modello", 65_536, "5.000000", "manual", true],
      ["modello-b", "modello-b", null, null, null, true],
      ["modello-c", "Modello C", null, "0.100000", "provider", true],
    ]);
    expect(after[0]!.id).toBe(before[0]!.id);
  });

  it("errore del provider → 200 con status error e messaggio fisso; poi torna ok", async () => {
    const acc = await createAccount();
    fake.status = 429;
    let res = await api("POST", `/ai/accounts/${acc.id}/verify`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "error", lastError: "limite di richieste del provider: riprova più tardi", modelCount: 2 });
    fake.status = null;
    res = await api("POST", `/ai/accounts/${acc.id}/verify`);
    expect(res.json).toMatchObject({ status: "ok", lastError: null });
  });
});

describe("modifica", () => {
  it("il nome non rilegge i modelli; chiave '' invariata, nuova chiave e base URL rileggono", async () => {
    const acc = await createAccount();
    let res = await api("PATCH", `/ai/accounts/${acc.id}`, { name: "Rinominato", apiKey: "" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ name: "Rinominato", keySet: true });
    expect(fake.requests).toHaveLength(1);

    fake.apiKey = KEY2;
    res = await api("PATCH", `/ai/accounts/${acc.id}`, { apiKey: ` ${KEY2} ` });
    expect(res.json).toMatchObject({ status: "ok", keySet: true });
    expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${KEY2}`);

    // Chiave sbagliata: 400 e nulla cambia; la verifica successiva usa ancora la chiave buona
    res = await api("PATCH", `/ai/accounts/${acc.id}`, { apiKey: "sk-sbagliata", name: "Non salvato" });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "chiave non valida o senza permessi" });
    res = await api("POST", `/ai/accounts/${acc.id}/verify`);
    expect(res.json).toMatchObject({ name: "Rinominato", status: "ok", keySet: true, lastError: null });
    expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${KEY2}`);

    fake.apiKey = null;
    res = await api("PATCH", `/ai/accounts/${acc.id}`, { apiKey: null });
    expect(res.json).toMatchObject({ keySet: false, status: "ok" });

    const other = await startFakeProvider({ models: [{ id: "altro" }] });
    try {
      res = await api("PATCH", `/ai/accounts/${acc.id}`, { baseUrl: `${other.baseUrl}/` });
      expect(res.json).toMatchObject({ baseUrl: other.baseUrl, status: "ok", modelCount: 3 });
      expect(other.requests).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it("base URL che non risponde → 400 e account invariato (URL, stato, modelli)", async () => {
    const acc = await createAccount();
    const before = await modelsOf(acc.id);
    const broken = await startFakeProvider({ status: 500, models: [{ id: "mai-salvato" }] });
    try {
      const res = await api("PATCH", `/ai/accounts/${acc.id}`, { baseUrl: broken.baseUrl });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "provider non raggiungibile" });
      expect(broken.requests).toHaveLength(1);
    } finally {
      await broken.close();
    }
    const [row] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, acc.id));
    expect(row).toMatchObject({ baseUrl: fake.baseUrl, status: "ok", lastError: null });
    expect(await modelsOf(acc.id)).toEqual(before);
    // La verifica va ancora al vecchio indirizzo con la vecchia chiave
    const res = await api("POST", `/ai/accounts/${acc.id}/verify`);
    expect(res.json).toMatchObject({ status: "ok", baseUrl: fake.baseUrl });
    expect(fake.requests.at(-1)).toMatchObject({ path: "/v1/models", authorization: `Bearer ${KEY}` });
  });

  it("nome: caratteri di controllo e oltre 100 caratteri → 400, in creazione e in modifica", async () => {
    for (const name of ["a\nb", "tab\tqui", "x".repeat(101)]) {
      expect((await api("POST", "/ai/accounts", customInput({ name }))).status, name).toBe(400);
    }
    expect(fake.requests).toHaveLength(0);
    const acc = await createAccount();
    for (const name of ["a\u0007b", "   ", "x".repeat(101)]) {
      expect((await api("PATCH", `/ai/accounts/${acc.id}`, { name })).status, name).toBe(400);
    }
    const [row] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, acc.id));
    expect(row!.name).toBe("Locale");
  });

  it("indirizzo privato senza consenso → 400 senza salvare; consenso e base URL solo per custom", async () => {
    const acc = await createAccount();
    let res = await api("PATCH", `/ai/accounts/${acc.id}`, { allowPrivateNetwork: false });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "indirizzo non consentito" });
    const [row] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, acc.id));
    expect(row!.allowPrivateNetwork).toBe(true);

    const userId = await devUserId();
    const [ds] = await db
      .insert(aiAccountsTable)
      .values({ userId, name: "DS", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnc: encryptSecret(KEY), status: "ok" })
      .returning();
    for (const body of [{ allowPrivateNetwork: true }, { baseUrl: "https://altro.example.com/v1" }, { apiKey: null }]) {
      res = await api("PATCH", `/ai/accounts/${ds!.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // Disattivare il consenso (già falso) è innocuo
    res = await api("PATCH", `/ai/accounts/${ds!.id}`, { allowPrivateNetwork: false, name: "DeepSeek" });
    expect(res.status).toBe(200);
  });

  it("senza la deroga dei test il loopback è rifiutato anche con il consenso, senza contattarlo (R6)", async () => {
    const acc = await createAccount();
    restoreLoopback();
    try {
      const before = fake.requests.length;
      let res = await api("POST", "/ai/accounts", customInput({ name: "Loopback" }));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "indirizzo non consentito" });
      res = await api("PATCH", `/ai/accounts/${acc.id}`, { baseUrl: "http://localhost:1/v1" });
      expect(res.status).toBe(400);
      // L'account già salvato su 127.0.0.1 non viene più contattato: la verifica lo segna in errore
      res = await api("POST", `/ai/accounts/${acc.id}/verify`);
      expect(res.json).toMatchObject({ status: "error", lastError: "indirizzo non consentito" });
      expect(fake.requests.length).toBe(before);
      const rows = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.name, "Loopback"));
      expect(rows).toHaveLength(0);
    } finally {
      restoreLoopback = allowTestLoopback();
    }
  });
});

describe("eliminazione", () => {
  const SOURCES = { code: "none", openapi: false, description: true } as const;

  it("in uso da agenti o analisi in corso → 409 con i nomi; altrimenti 204 e modelli eliminati", async () => {
    const acc = await createAccount();
    const [m] = await modelsOf(acc.id);
    const app = await newApp();
    await db.insert(agentsTable).values({ appId: app.id, name: "Agente Mister", aiModelId: m!.id });
    const [analysis] = await db
      .insert(analysesTable)
      .values({ appId: app.id, model: "x", aiModelId: m!.id, status: "running", sources: SOURCES, maxTokens: 1000 })
      .returning();
    // Le analisi concluse non compaiono nell'elenco
    await db
      .insert(analysesTable)
      .values({ appId: app.id, model: "x", aiModelId: m!.id, status: "completed", sources: SOURCES, maxTokens: 1000 });
    let res = await api("DELETE", `/ai/accounts/${acc.id}`);
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: `account usato da: Agente Mister, analisi #${analysis!.id}` });

    await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
    res = await api("DELETE", `/ai/accounts/${acc.id}`);
    expect(res.status).toBe(204);
    expect(await modelsOf(acc.id)).toHaveLength(0);
    expect((await api("DELETE", `/ai/accounts/${acc.id}`)).status).toBe(404);
  });

  it("usato solo da analisi concluse → 204: le analisi perdono il collegamento e tengono modello e costo", async () => {
    const acc = await createAccount();
    const [m] = await modelsOf(acc.id);
    const app = await newApp();
    const ids: number[] = [];
    for (const status of ["completed", "failed", "interrupted"] as const) {
      const [row] = await db
        .insert(analysesTable)
        .values({ appId: app.id, model: "deepseek-chat", aiModelId: m!.id, status, sources: SOURCES, maxTokens: 1000, costUsd: "0.012345" })
        .returning();
      ids.push(row!.id);
    }
    const res = await api("DELETE", `/ai/accounts/${acc.id}`);
    expect(res.status, res.text).toBe(204);
    const [analysis] = await db.select().from(analysesTable).where(eq(analysesTable.id, ids[0]!));
    expect(analysis).toMatchObject({ model: "deepseek-chat", costUsd: "0.012345", aiModelId: null });
    const rest = await db.select().from(analysesTable);
    expect(rest.map((r) => r.aiModelId)).toEqual([null, null, null]);
  });

  it("usato da un'analisi in coda o in esecuzione → 409", async () => {
    for (const status of ["queued", "running"] as const) {
      const acc = await createAccount();
      const [m] = await modelsOf(acc.id);
      const app = await newApp();
      const [analysis] = await db
        .insert(analysesTable)
        .values({ appId: app.id, model: "x", aiModelId: m!.id, status, sources: SOURCES, maxTokens: 1000 })
        .returning();
      const res = await api("DELETE", `/ai/accounts/${acc.id}`);
      expect(res.status, status).toBe(409);
      expect(res.json).toEqual({ error: `account usato da: analisi #${analysis!.id}` });
      expect(await modelsOf(acc.id)).not.toHaveLength(0);
    }
  });

  it("al massimo 10 nomi, poi …", async () => {
    const acc = await createAccount();
    const [m] = await modelsOf(acc.id);
    for (let i = 0; i < 12; i++) {
      const app = await newApp();
      await db.insert(agentsTable).values({ appId: app.id, name: `Agente ${String(i).padStart(2, "0")}`, aiModelId: m!.id });
    }
    const res = await api("DELETE", `/ai/accounts/${acc.id}`);
    expect(res.status).toBe(409);
    const names = Array.from({ length: 10 }, (_, i) => `Agente ${String(i).padStart(2, "0")}`);
    expect(res.json.error).toBe(`account usato da: ${names.join(", ")}, …`);
  });

  it("eliminando il predefinito diventa predefinito l'account più vecchio rimasto", async () => {
    const a = await createAccount({ name: "Z vecchio" });
    const b = await createAccount({ name: "A nuovo" });
    const c = await createAccount({ name: "M più nuovo" });
    await api("POST", `/ai/accounts/${c.id}/default`);
    expect((await api("DELETE", `/ai/accounts/${c.id}`)).status).toBe(204);
    const defaults = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.isDefault, true));
    expect(defaults.map((d) => d.id)).toEqual([a.id]);
    // Eliminare un account non predefinito non cambia il predefinito
    expect((await api("DELETE", `/ai/accounts/${b.id}`)).status).toBe(204);
    const [row] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, a.id));
    expect(row!.isDefault).toBe(true);
  });
});

describe("modelli", () => {
  it("aggiunta manuale: discovered false, prezzi manual; duplicato 409; id con caratteri di controllo 400", async () => {
    fake.models = null;
    const acc = await createAccount();
    let res = await api("POST", `/ai/accounts/${acc.id}/models`, { modelId: " llama3 ", displayName: "Llama 3", priceInput: 0.1, priceOutput: 0.2, contextTokens: 8192 });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({ modelId: "llama3", displayName: "Llama 3", priceInput: 0.1, priceOutput: 0.2, priceSource: "manual", contextTokens: 8192, hidden: false });
    const [row] = await modelsOf(acc.id);
    expect(row!.discovered).toBe(false);

    res = await api("POST", `/ai/accounts/${acc.id}/models`, { modelId: "qwen" });
    expect(res.json).toMatchObject({ displayName: "qwen", priceInput: null, priceOutput: null, priceSource: null, contextTokens: null });

    expect((await api("POST", `/ai/accounts/${acc.id}/models`, { modelId: "llama3" })).status).toBe(409);
    expect((await api("POST", `/ai/accounts/${acc.id}/models`, { modelId: "a\nb" })).status).toBe(400);
    expect((await api("POST", `/ai/accounts/${acc.id}/models`, { modelId: "x", priceInput: -1 })).status).toBe(400);
    expect((await api("POST", `/ai/accounts/${acc.id}/models`, { modelId: "x", priceInput: 1e6 })).status).toBe(400);
  });

  it("modifica: nome, prezzi (fonte manual) e nascosto", async () => {
    const acc = await createAccount();
    const [m] = await modelsOf(acc.id);
    let res = await api("PATCH", `/ai/models/${m!.id}`, { displayName: "Nuovo nome", priceOutput: 3.5 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ displayName: "Nuovo nome", priceInput: 1, priceOutput: 3.5, priceSource: "manual", hidden: false });
    res = await api("PATCH", `/ai/models/${m!.id}`, { hidden: true });
    expect(res.json).toMatchObject({ hidden: true, priceSource: "manual" });
    res = await api("PATCH", `/ai/models/${m!.id}`, { priceInput: null });
    expect(res.json).toMatchObject({ priceInput: null });
    expect((await api("PATCH", `/ai/models/${m!.id}`, { priceInput: 2_000_000 })).status).toBe(400);
    expect((await api("PATCH", `/ai/models/999999`, { hidden: true })).status).toBe(404);
  });
});

describe("modelli selezionabili", () => {
  it("propri account (predefinito, poi per nome, in errore in fondo) e sistema per ultimo; nascosti esclusi", async () => {
    await ensureSystemAccount();
    const z = await createAccount({ name: "Zeta" });
    const b = await createAccount({ name: "Beta" });
    const a = await createAccount({ name: "Alfa" });
    const broken = await createAccount({ name: "Aaa rotto" });
    fake.status = 500;
    await api("POST", `/ai/accounts/${broken.id}/verify`);
    fake.status = null;
    const [hiddenModel] = await modelsOf(b.id);
    await api("PATCH", `/ai/models/${hiddenModel!.id}`, { hidden: true });

    const res = await api("GET", "/ai/models");
    expect(res.status).toBe(200);
    const groups = res.json as { account: { id: number; name: string; isSystem: boolean; status: string }; models: { modelId: string }[] }[];
    expect(groups.map((g) => g.account.name)).toEqual(["Zeta", "Alfa", "Beta", "Aaa rotto", "Gateway Casello"]);
    expect(groups[0]!.account.id).toBe(z.id);
    expect(groups[1]!.account.id).toBe(a.id);
    expect(groups[2]!.models.map((m) => m.modelId)).toEqual(["modello-b"]);
    expect(groups[3]!.account.status).toBe("error");
    expect(groups[4]!.account.isSystem).toBe(true);
    expect(groups[4]!.models.length).toBeGreaterThan(0);

    // Stesso ordine nell'elenco degli account
    const list = await api("GET", "/ai/accounts");
    expect(list.json.map((x: { name: string }) => x.name)).toEqual(["Zeta", "Alfa", "Beta", "Aaa rotto", "Gateway Casello"]);
  });

  it("senza variabili del gateway l'account di sistema non compare e le sue route rispondono 404", async () => {
    const sys = await ensureSystemAccount();
    const [sysModel] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, sys!.accountId)).limit(1);
    const url = process.env["AI_GATEWAY_BASE_URL"];
    delete process.env["AI_GATEWAY_BASE_URL"];
    try {
      expect((await api("GET", "/ai/models")).json).toEqual([]);
      expect((await api("GET", "/ai/accounts")).json).toEqual([]);
      expect((await api("GET", `/ai/accounts/${sys!.accountId}/models`)).status).toBe(404);
      expect((await api("GET", `/ai/estimate?aiModelId=${sysModel!.id}`)).status).toBe(404);
    } finally {
      process.env["AI_GATEWAY_BASE_URL"] = url;
    }
  });
});

describe("stato, selezionabilità e preselezione", () => {
  it("GET /ai/models riporta stato, selezionabile e un solo consigliato per gruppo", async () => {
    await ensureSystemAccount();
    const acc = await createAccount();
    const [a, b] = await modelsOf(acc.id);
    // modello-a (il più economico) è ritirato dal catalogo: il consigliato diventa modello-b
    const [cat] = await db
      .insert(modelCatalogTable)
      .values({ provider: "custom", modelId: "modello-a", family: "Modello", version: "A", status: "retired", deprecationDate: new Date("2026-01-01T00:00:00Z") })
      .returning();
    await db.update(aiModelsTable).set({ catalogId: cat!.id }).where(eq(aiModelsTable.id, a!.id));

    const res = await api("GET", "/ai/models");
    expect(res.status, res.text).toBe(200);
    const groups = res.json as { account: { isSystem: boolean }; models: Record<string, unknown>[] }[];
    const mine = groups.find((g) => !g.account.isSystem)!;
    expect(mine.models.find((m) => m.id === a!.id)).toMatchObject({
      status: "retired",
      selectable: false,
      recommended: false,
      availability: "unknown",
      supportsTools: null,
      deprecationDate: "2026-01-01T00:00:00.000Z",
      releasedAt: null,
      lastProbeAt: null,
      lastProbeOk: null,
    });
    expect(mine.models.find((m) => m.id === b!.id)).toMatchObject({ status: "available", selectable: true, recommended: true });
    for (const g of groups) expect(g.models.filter((m) => m.recommended).length).toBeLessThanOrEqual(1);
    const sys = groups.find((g) => g.account.isSystem)!;
    expect(sys.models.filter((m) => m.recommended)).toHaveLength(1);

    // Un modello non disponibile resta in elenco ma non è selezionabile
    await db.update(aiModelsTable).set({ availability: "unavailable" }).where(eq(aiModelsTable.id, b!.id));
    const again = (await api("GET", "/ai/models")).json as typeof groups;
    const mine2 = again.find((g) => !g.account.isSystem)!;
    expect(mine2.models.find((m) => m.id === b!.id)).toMatchObject({ status: "unavailable", selectable: false, recommended: false });
    expect(mine2.models.some((m) => m.recommended)).toBe(false);
  });

  it("anche l'elenco dei modelli dell'account e la modifica portano stato e catalogo", async () => {
    const acc = await createAccount();
    const [a] = await modelsOf(acc.id);
    const list = await api("GET", `/ai/accounts/${acc.id}/models`);
    expect(list.json[0]).toMatchObject({ status: "available", selectable: true, recommended: false });
    const patched = await api("PATCH", `/ai/models/${a!.id}`, { hidden: true });
    expect(patched.json).toMatchObject({ status: "available", hidden: true });
  });
});

describe("prova del modello", () => {
  it("modello proprio: una chiamata con max_tokens 1, esito e costo; disponibilità aggiornata", async () => {
    const acc = await createAccount();
    const [a] = await modelsOf(acc.id);
    fake.requests = [];
    const res = await api("POST", `/ai/models/${a!.id}/probe`);
    expect(res.status, res.text).toBe(200);
    // Prezzi di modello-a: 1 $ e 2 $ per milione; 10 token in ingresso, 5 in uscita
    expect(res.json).toMatchObject({ ok: true, error: null, costUsd: 0.00002 });
    expect(res.json.model).toMatchObject({ id: a!.id, availability: "available", lastProbeOk: true, status: "available" });
    expect(typeof res.json.model.lastProbeAt).toBe("string");
    const chat = fake.requests.filter((r) => r.path === "/v1/chat/completions");
    expect(chat).toHaveLength(1);
    expect(chat[0]!.body).toMatchObject({ model: "modello-a", max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
    const [row] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.id, a!.id));
    expect(row).toMatchObject({ availability: "available", lastProbeOk: true });
    expect(row!.lastProbeAt).toBeInstanceOf(Date);
  });

  it("chat 404 → ok false con messaggio fisso e modello non disponibile", async () => {
    const acc = await createAccount();
    const [a] = await modelsOf(acc.id);
    fake.statusFor = { chat: 404 };
    const res = await api("POST", `/ai/models/${a!.id}/probe`);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ ok: false, error: "richiesta rifiutata dal provider (HTTP 404)", costUsd: null });
    expect(res.json.model).toMatchObject({ availability: "unavailable", status: "unavailable", selectable: false, lastProbeOk: false });
    // Un solo tentativo
    expect(fake.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(1);
    const [row] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.id, a!.id));
    expect(row).toMatchObject({ availability: "unavailable", lastProbeOk: false });
  });

  it("modello di un altro utente, di sistema o inesistente → 404, nessuna chiamata", async () => {
    const other = await otherUserAccount();
    const sys = await ensureSystemAccount();
    const [sysModel] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, sys!.accountId)).limit(1);
    for (const id of [other.model.id, sysModel!.id, 999999]) {
      const res = await api("POST", `/ai/models/${id}/probe`);
      expect(res.status, String(id)).toBe(404);
      expect(res.json).toEqual({ error: "modello non trovato" });
    }
    const [row] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.id, other.model.id));
    expect(row).toMatchObject({ lastProbeAt: null, availability: "unknown" });
    expect(fake.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(0);
  });
});

describe("isolamento e account di sistema", () => {
  it("l'account di un altro utente è invisibile e ogni route risponde 404", async () => {
    const other = await otherUserAccount();
    await createAccount();
    expect((await api("GET", "/ai/accounts")).text).not.toContain("Account dell'altro");
    expect((await api("GET", "/ai/models")).text).not.toContain("Account dell'altro");
    const id = other.account.id;
    const calls: [string, string, unknown?][] = [
      ["PATCH", `/ai/accounts/${id}`, { name: "preso" }],
      ["DELETE", `/ai/accounts/${id}`],
      ["POST", `/ai/accounts/${id}/verify`],
      ["POST", `/ai/accounts/${id}/default`],
      ["GET", `/ai/accounts/${id}/models`],
      ["POST", `/ai/accounts/${id}/models`, { modelId: "x" }],
      ["PATCH", `/ai/models/${other.model.id}`, { hidden: true }],
      ["GET", `/ai/estimate?aiModelId=${other.model.id}`],
    ];
    for (const [method, path, body] of calls) {
      const res = await api(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const [row] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, id));
    expect(row).toMatchObject({ name: "Account dell'altro", isDefault: true });
    const [model] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.id, other.model.id));
    expect(model!.hidden).toBe(false);
  });

  it("account di sistema: visibile, ma modifiche, eliminazione, verifica e modelli → 403", async () => {
    const sys = await ensureSystemAccount();
    const id = sys!.accountId;
    const list = await api("GET", "/ai/accounts");
    // L'indirizzo del gateway non si espone
    expect(list.json).toEqual([expect.objectContaining({ id, isSystem: true, isDefault: false, provider: "system_gateway", baseUrl: "" })]);
    expect(list.text).not.toContain("gateway.interno");
    expect((await api("GET", "/ai/models")).text).not.toContain("gateway.interno");
    const models = await api("GET", `/ai/accounts/${id}/models`);
    expect(models.status).toBe(200);
    const modelId = models.json[0].id as number;
    const calls: [string, string, unknown?][] = [
      ["PATCH", `/ai/accounts/${id}`, { name: "mio" }],
      ["DELETE", `/ai/accounts/${id}`],
      ["POST", `/ai/accounts/${id}/verify`],
      ["POST", `/ai/accounts/${id}/default`],
      ["POST", `/ai/accounts/${id}/models`, { modelId: "x" }],
      ["PATCH", `/ai/models/${modelId}`, { hidden: true }],
    ];
    for (const [method, path, body] of calls) {
      const res = await api(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json).toEqual({ error: SYSTEM_MESSAGE });
    }
    const [row] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, id));
    expect(row).toMatchObject({ name: "Gateway Casello", isDefault: false });
  });
});

describe("stima del costo", () => {
  it("massimo e tipico con prezzi noti; null senza prezzi; modello di sistema ammesso", async () => {
    const acc = await createAccount();
    const [withPrice, noPrice] = await modelsOf(acc.id);
    await api("PATCH", `/ai/models/${withPrice!.id}`, { priceInput: 0.28, priceOutput: 0.42 });
    let res = await api("GET", `/ai/estimate?aiModelId=${withPrice!.id}&maxTokens=1000000`);
    expect(res.status).toBe(200);
    // 1e6 × (0.95 × 0.28 + 0.05 × 0.42) / 1e6 = 0.287; tipico 0.1722
    expect(res.json).toEqual({ maxUsd: 0.287, typicalUsd: 0.1722 });
    // Default 1 000 000 token
    expect((await api("GET", `/ai/estimate?aiModelId=${withPrice!.id}`)).json).toEqual({ maxUsd: 0.287, typicalUsd: 0.1722 });
    res = await api("GET", `/ai/estimate?aiModelId=${withPrice!.id}&maxTokens=123450`);
    // Fino a 6 decimali: 0.03543015 → 0.03543; tipico 0.02125809 → 0.021258
    expect(res.json).toEqual({ maxUsd: 0.03543, typicalUsd: 0.021258 });
    // Stessi limiti dell'analisi: 50 000 – 2 000 000
    expect((await api("GET", `/ai/estimate?aiModelId=${withPrice!.id}&maxTokens=50000`)).status).toBe(200);
    expect((await api("GET", `/ai/estimate?aiModelId=${withPrice!.id}&maxTokens=2000000`)).status).toBe(200);
    expect((await api("GET", `/ai/estimate?aiModelId=${withPrice!.id}&maxTokens=49999`)).status).toBe(400);
    expect((await api("GET", `/ai/estimate?aiModelId=${withPrice!.id}&maxTokens=2000001`)).status).toBe(400);

    res = await api("GET", `/ai/estimate?aiModelId=${noPrice!.id}&maxTokens=1000000`);
    expect(res.json).toEqual({ maxUsd: null, typicalUsd: null });

    // Costo positivo minuscolo (5e-8 $): mai arrotondato a 0
    await api("PATCH", `/ai/models/${noPrice!.id}`, { priceInput: 0.000001, priceOutput: 0.000001 });
    res = await api("GET", `/ai/estimate?aiModelId=${noPrice!.id}&maxTokens=50000`);
    expect(res.json).toEqual({ maxUsd: 0.000001, typicalUsd: 0.000001 });
    // Prezzi a zero: 0 resta 0
    await api("PATCH", `/ai/models/${noPrice!.id}`, { priceInput: 0, priceOutput: 0 });
    res = await api("GET", `/ai/estimate?aiModelId=${noPrice!.id}&maxTokens=50000`);
    expect(res.json).toEqual({ maxUsd: 0, typicalUsd: 0 });

    const sys = await ensureSystemAccount();
    const [sysModel] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, sys!.accountId)).limit(1);
    expect((await api("GET", `/ai/estimate?aiModelId=${sysModel!.id}`)).status).toBe(200);

    expect((await api("GET", "/ai/estimate?aiModelId=999999")).status).toBe(404);
    expect((await api("GET", `/ai/estimate?aiModelId=${withPrice!.id}&maxTokens=0`)).status).toBe(400);
    expect((await api("GET", "/ai/estimate")).status).toBe(400);
  });
});

describe("app completa", () => {
  it("le route sono montate dietro il login, GET /models resta e le chiamate ai provider hanno un rate limit", async () => {
    const res = await api("GET", "/ai/accounts", undefined, fullBase);
    expect(res.status).toBe(200);
    const legacy = await api("GET", "/models", undefined, fullBase);
    expect(legacy.status).toBe(200);
    expect(legacy.json[0]).toEqual({ id: expect.any(String), label: expect.any(String), isDefault: expect.any(Boolean) });

    // 20 chiamate verso i provider al minuto per IP (qui su un account inesistente: 404)
    for (let i = 0; i < 20; i++) {
      expect((await api("POST", "/ai/accounts/999999/verify", undefined, fullBase)).status).toBe(404);
    }
    const limited = await api("POST", "/ai/accounts", customInput(), fullBase);
    expect(limited.status).toBe(429);
    // Le letture non sono limitate
    expect((await api("GET", "/ai/models", undefined, fullBase)).status).toBe(200);
    expect(await db.select().from(aiAccountsTable).where(and(eq(aiAccountsTable.provider, "custom")))).toHaveLength(0);
  });

  it("la prova del modello ha un suo limite di 5 al minuto", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await api("POST", "/ai/models/999999/probe", undefined, fullBase)).status).toBe(404);
    }
    expect((await api("POST", "/ai/models/999999/probe", undefined, fullBase)).status).toBe(429);
  });
});

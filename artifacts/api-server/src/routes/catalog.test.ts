import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, catalogRunsTable, modelOffersTable, modelsTable, providersTable, usersTable } from "@workspace/db";
import { fakeSourcesFetch } from "../../test/fake-sources";
import { encryptSecret } from "../lib/secrets";
import { ensureProviderRegistry } from "../lib/catalog/provider-registry";
import { LEGACY_GATEWAY_PROVIDER } from "../lib/ai/providers";

// API del catalogo su un'app Express vera (porta 0), senza login (AUTH_DISABLED=true). Il secondo
// utente si inserisce a mano. Le fonti sono finte; ogni aggiornamento avviato si attende prima di
// chiudere il test, così nessuna riga `running` resta per gli altri file.

const realFetch = globalThis.fetch;
const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};
// I provider di oggi, già in docs/schema-casello.sql con la riga rimasta del vecchio gateway (DB di prova condiviso)
const TODAY = ["deepseek", "openrouter", "huggingface", "mistral", "groq", "together", "gemini", "custom", LEGACY_GATEWAY_PROVIDER];

let base: string;
let fullBase: string;
let server: http.Server;
let fullServer: http.Server;
let currentFetch: typeof fetch;

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
async function api(method: string, path: string, root = base): Promise<{ status: number; text: string; json: any }> {
  const res = await realFetch(`${root}/api${path}`, { method });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function waitIdle(): Promise<void> {
  for (;;) {
    const rows = await db.select().from(catalogRunsTable);
    if (!rows.some((r) => r.status === "running")) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function devUserId(): Promise<number> {
  const [u] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  return u!.id;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);

  const { requireAuth } = await import("../lib/auth");
  const { createCatalogRouter } = await import("./catalog");
  const { errorHandler } = await import("../middlewares/error-handler");
  const noLimit: RequestHandler = (_req, _res, next) => next();
  const mini = express();
  mini.use(express.json());
  // Il fetch delle fonti si legge a ogni chiamata, così ogni test può cambiarlo
  const fetchImpl = ((...args: Parameters<typeof fetch>) => currentFetch(...args)) as typeof fetch;
  mini.use("/api", requireAuth, createCatalogRouter({ refreshRateLimit: noLimit, fetchImpl }));
  mini.use("/api", errorHandler);
  server = http.createServer(mini);
  base = `http://127.0.0.1:${await listen(server)}`;

  const { default: app } = await import("../app");
  fullServer = http.createServer(app);
  fullBase = `http://127.0.0.1:${await listen(fullServer)}`;
});

afterAll(async () => {
  await waitIdle();
  await close(server);
  await close(fullServer);
  await pool.query("TRUNCATE users, ai_accounts, catalog_runs, models RESTART IDENTITY CASCADE");
  // L'aggiornamento aggiunge i provider del registro e quelli scoperti: restano solo quelli di oggi
  await pool.query("DELETE FROM providers WHERE slug <> ALL($1)", [TODAY]);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  currentFetch = fakeSourcesFetch();
  await waitIdle();
  await pool.query("TRUNCATE users, ai_accounts, catalog_runs, models RESTART IDENTITY CASCADE");
});

/** Fonti che rispondono solo dopo `release()`: tiene l'aggiornamento in corso quanto serve al test. */
function gatedSources(): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inner = fakeSourcesFetch();
  currentFetch = (async (...args: Parameters<typeof fetch>) => {
    await gate;
    return inner(...args);
  }) as typeof fetch;
  return release;
}

describe("aggiornamento", () => {
  it("risponde 202 running; a fine esecuzione lo stato è completed", async () => {
    const release = gatedSources();
    const res = await api("POST", "/catalog/refresh");
    expect(res.status, res.text).toBe(202);
    expect(res.json).toMatchObject({ trigger: "manual", status: "running", finishedAt: null, summary: null });
    expect((await api("GET", "/catalog/status")).json).toMatchObject({ running: true, latest: { id: res.json.id, status: "running" } });

    release();
    await waitIdle();
    const status = await api("GET", "/catalog/status");
    expect(status.json.running).toBe(false);
    expect(status.json.latest).toMatchObject({ id: res.json.id, status: "completed", error: null });
    expect(status.json.latest.finishedAt).toEqual(expect.any(String));
    expect(status.json.latest.summary).toMatchObject({ firstRun: true, accounts: [] });

    // Seconda esecuzione: ora le novità sono calcolate (nulla di cambiato con le stesse fonti)
    await api("POST", "/catalog/refresh");
    await waitIdle();
    const second = await api("GET", "/catalog/status");
    expect(second.json.latest.summary).toMatchObject({ firstRun: false, added: [] });
  });

  it("un secondo aggiornamento durante il primo risponde 409", async () => {
    const release = gatedSources();

    const first = await api("POST", "/catalog/refresh");
    expect(first.status).toBe(202);
    const second = await api("POST", "/catalog/refresh");
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: "aggiornamento già in corso" });
    release();
    await waitIdle();
  });

  it("lo stato senza esecuzioni è vuoto", async () => {
    expect((await api("GET", "/catalog/status")).json).toEqual({ running: false, latest: null, lastCompleted: null });
  });

  it("dopo un'esecuzione fallita le novità restano quelle dell'ultima riuscita", async () => {
    const summary = { firstRun: false, added: [{ provider: "deepseek", modelId: "nuovo", version: "1" }], retired: [], deprecating: [], priceChanged: [], accounts: [] };
    const [ok] = await db
      .insert(catalogRunsTable)
      .values({ trigger: "scheduled", status: "completed", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(), summary })
      .returning();
    const [ko] = await db
      .insert(catalogRunsTable)
      .values({ trigger: "manual", status: "failed", error: "fonte non raggiungibile", finishedAt: new Date() })
      .returning();

    const res = await api("GET", "/catalog/status");
    expect(res.json.latest).toMatchObject({ id: ko!.id, status: "failed", summary: null });
    expect(res.json.lastCompleted).toMatchObject({ id: ok!.id, status: "completed", summary: { added: [expect.objectContaining({ modelId: "nuovo" })] } });
  });

  it("ha un rate limit di 2 al minuto sull'app completa", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await api("POST", "/catalog/refresh", fullBase)).status);
      await waitIdle();
    }
    expect(codes).toEqual([202, 202, 429]);
  });
});

describe("riepilogo per utente", () => {
  it("mostra solo gli account dell'utente corrente, senza userId", async () => {
    const me = await devUserId().catch(async () => {
      await api("GET", "/catalog/status");
      return devUserId();
    });
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
    const [mine, theirs] = await db
      .insert(aiAccountsTable)
      .values([
        { userId: me, name: "Mio", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnc: encryptSecret("sk-x"), status: "ok" },
        { userId: other!.id, name: "Dell'altro", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnc: encryptSecret("sk-y"), status: "ok" },
      ])
      .returning();
    await db.insert(catalogRunsTable).values({
      trigger: "scheduled",
      status: "completed",
      finishedAt: new Date(),
      summary: {
        firstRun: false,
        added: [],
        retired: [],
        deprecating: [],
        priceChanged: [],
        accounts: [
          { accountId: mine!.id, userId: me, accountName: "Mio", missing: ["a"] },
          { accountId: theirs!.id, userId: other!.id, accountName: "Dell'altro", missing: ["b"] },
        ],
      },
    });

    const res = await api("GET", "/catalog/status");
    expect(res.json.latest.summary.accounts).toEqual([{ accountId: mine!.id, accountName: "Mio", missing: ["a"] }]);
    expect(res.text).not.toContain("userId");
    expect(res.text).not.toContain("Dell'altro");
  });
});

const UNMANAGED = "test-nuovo";

/**
 * Catalogo di prova: claude (4 offerte, una senza prezzo), deepseek (2), un embedding, un modello con sole
 * offerte ritirate e gpt-5000 senza prezzi. L'utente corrente ha un account deepseek collegato all'offerta
 * deepseek; un altro utente ha un account anthropic collegato a claude.
 */
async function seedCatalog() {
  await ensureProviderRegistry();
  await db
    .insert(providersTable)
    .values({
      slug: UNMANAGED,
      name: "Nuovo Provider",
      protocol: "unknown",
      status: "unmanaged",
      origin: "discovered",
      sourceKeys: { litellm: ["nuovo_provider"], openrouterAuthor: null },
    })
    .onConflictDoNothing();
  await api("GET", "/catalog/status");
  const me = await devUserId();
  const [other] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();

  const [claude, deepseek, embedding, old, gpt] = await db
    .insert(modelsTable)
    .values([
      { canonicalKey: "claude-sonnet-4-5", author: "Anthropic", family: "Claude Sonnet", version: "4.5", mode: "chat", supportsTools: true, supportsVision: true, supportsReasoning: true, releasedAt: new Date("2025-09-29") },
      { canonicalKey: "deepseek-chat", author: "DeepSeek", family: "DeepSeek", version: "V3.2", mode: "chat", supportsTools: true, supportsVision: false, supportsReasoning: false, releasedAt: new Date("2025-12-01") },
      { canonicalKey: "text-embedding-3-small", author: "OpenAI", family: "Text Embedding", version: "3 small", mode: "embedding" },
      { canonicalKey: "claude-2", author: "Anthropic", family: "Claude", version: "2", mode: "chat" },
      { canonicalKey: "gpt-5000", author: "OpenAI", family: "GPT", version: "5000", mode: "chat" },
    ])
    .returning();
  const offers = await db
    .insert(modelOffersTable)
    .values([
      { modelId: claude!.id, provider: "anthropic", providerModelId: "claude-sonnet-4-5", priceInputPerMtok: "3", priceOutputPerMtok: "15", contextTokens: 200_000, supportsTools: true },
      { modelId: claude!.id, provider: "bedrock", providerModelId: "anthropic.claude-sonnet-4-5-v1:0", priceInputPerMtok: "3", priceOutputPerMtok: "15", contextTokens: 200_000 },
      { modelId: claude!.id, provider: "openrouter", providerModelId: "anthropic/claude-sonnet-4.5", priceInputPerMtok: "2.5", priceOutputPerMtok: "15", contextTokens: 1_000_000 },
      { modelId: claude!.id, provider: "vertex", providerModelId: "claude-sonnet-4-5@20250929", status: "deprecated", deprecationDate: new Date("2027-01-01") },
      { modelId: deepseek!.id, provider: "deepseek", providerModelId: "deepseek-chat", priceInputPerMtok: "0.28", priceOutputPerMtok: "0.42", contextTokens: 128_000, supportsTools: true },
      { modelId: deepseek!.id, provider: "openrouter", providerModelId: "deepseek/deepseek-chat", priceInputPerMtok: "0.3", priceOutputPerMtok: "0.5" },
      { modelId: embedding!.id, provider: "azure", providerModelId: "text-embedding-3-small", priceInputPerMtok: "0.02", priceOutputPerMtok: "0" },
      { modelId: old!.id, provider: "anthropic", providerModelId: "claude-2", priceInputPerMtok: "8", priceOutputPerMtok: "24", status: "retired" },
      { modelId: gpt!.id, provider: "openrouter", providerModelId: "openai/gpt-5000" },
    ])
    .returning();
  const offerOf = (provider: string, id: string) => offers.find((o) => o.provider === provider && o.providerModelId === id)!;
  const [mine, theirs] = await db
    .insert(aiAccountsTable)
    .values([
      { userId: me, name: "Mio", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnc: encryptSecret("sk-x"), status: "ok" },
      { userId: other!.id, name: "Altro", provider: "anthropic", baseUrl: "https://a.example.com/v1", apiKeyEnc: encryptSecret("sk-y"), status: "ok" },
    ])
    .returning();
  await db.insert(aiModelsTable).values([
    { accountId: mine!.id, modelId: "deepseek-chat", displayName: "D", offerId: offerOf("deepseek", "deepseek-chat").id },
    { accountId: theirs!.id, modelId: "claude-sonnet-4-5", displayName: "C", offerId: offerOf("anthropic", "claude-sonnet-4-5").id },
  ]);
  return { claude: claude!, deepseek: deepseek!, embedding: embedding!, old: old!, gpt: gpt! };
}

const keys = (res: { json: { items: { canonicalKey: string }[] } }) => res.json.items.map((m) => m.canonicalKey);
async function list(query = ""): Promise<{ status: number; text: string; json: any }> {
  return api("GET", `/catalog/models${query ? `?${query}` : ""}`);
}

describe("elenco dei modelli", () => {
  it("predefinito: solo chat, senza i modelli con sole offerte ritirate, per nome, pagina 1 da 50", async () => {
    await seedCatalog();
    const res = await list();
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ total: 3, page: 1, pageSize: 50 });
    expect(keys(res)).toEqual(["claude-sonnet-4-5", "deepseek-chat", "gpt-5000"]);
  });

  it("riepilogo del modello: offerta più economica, numero di offerte, nei miei account", async () => {
    const { claude } = await seedCatalog();
    const res = await list();
    const [c, d, g] = res.json.items;
    expect(c).toEqual({
      id: claude.id,
      canonicalKey: "claude-sonnet-4-5",
      author: "Anthropic",
      family: "Claude Sonnet",
      version: "4.5",
      mode: "chat",
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      releasedAt: "2025-09-29T00:00:00.000Z",
      offerCount: 4,
      providerCount: 4,
      cheapestOffer: { provider: "openrouter", priceInput: 2.5, priceOutput: 15 },
      // Collegato solo a un account di un altro utente
      inMyAccounts: false,
    });
    expect(d).toMatchObject({ offerCount: 2, cheapestOffer: { provider: "deepseek", priceInput: 0.28, priceOutput: 0.42 }, inMyAccounts: true });
    expect(g).toMatchObject({ offerCount: 1, cheapestOffer: null, inMyAccounts: false });
  });

  it("providerCount conta i provider distinti, offerCount le offerte", async () => {
    const { deepseek } = await seedCatalog();
    await db.insert(modelOffersTable).values({ modelId: deepseek.id, provider: "openrouter", providerModelId: "deepseek/deepseek-chat:free" });
    const d = (await list("q=deepseek")).json.items[0];
    expect(d).toMatchObject({ canonicalKey: "deepseek-chat", offerCount: 3, providerCount: 2 });
  });

  it("page oltre 10000 → 400", async () => {
    await seedCatalog();
    expect((await list("page=10000")).status).toBe(200);
    expect((await list("page=10001")).status).toBe(400);
  });

  it("paginazione: total su tutte le pagine; pageSize oltre 100 o page 0 → 400", async () => {
    await seedCatalog();
    const res = await list("pageSize=2&page=2");
    expect(res.json).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(keys(res)).toEqual(["gpt-5000"]);
    const beyond = await list("pageSize=2&page=9");
    expect(beyond.json).toMatchObject({ total: 3, items: [] });
    expect((await list("pageSize=101")).status).toBe(400);
    expect((await list("page=0")).status).toBe(400);
    expect((await list("page=1.5")).status).toBe(400);
    // total conta i modelli filtrati, non quelli della pagina
    const filtered = await list("provider=openrouter&pageSize=1&sort=price");
    expect(filtered.json).toMatchObject({ total: 3, page: 1, pageSize: 1 });
    expect(keys(filtered)).toEqual(["deepseek-chat"]);
    expect((await list("provider=openrouter&usable=true&pageSize=1")).json).toMatchObject({ total: 1 });
    expect((await list("sort=nope")).status).toBe(400);
  });

  it("mode: un tipo, oppure all per tutti", async () => {
    await seedCatalog();
    expect(keys(await list("mode=embedding"))).toEqual(["text-embedding-3-small"]);
    expect((await list("mode=all")).json.total).toBe(4);
    expect((await list("mode=nope")).status).toBe(400);
  });

  it("q: per chiave, famiglia, autore e id presso il provider, senza distinguere maiuscole", async () => {
    await seedCatalog();
    expect(keys(await list("q=claude"))).toEqual(["claude-sonnet-4-5"]);
    expect(keys(await list("q=SONNET"))).toEqual(["claude-sonnet-4-5"]);
    // Solo nell'id di Bedrock e di OpenRouter
    expect(keys(await list(`q=${encodeURIComponent("v1:0")}`))).toEqual(["claude-sonnet-4-5"]);
    expect(keys(await list("q=sonnet-4.5"))).toEqual(["claude-sonnet-4-5"]);
    expect(keys(await list("q=openai"))).toEqual(["gpt-5000"]);
    expect(keys(await list("q=deepseek"))).toEqual(["deepseek-chat"]);
  });

  it("q con % _ e \\: caratteri letterali, nessun errore e nessun risultato spurio", async () => {
    await seedCatalog();
    // Senza escape, %50%_% troverebbe gpt-5000
    for (const q of ["50%_", "5_0", "%", "_", "\\", "50\\"]) {
      const res = await list(`q=${encodeURIComponent(q)}`);
      expect(res.status, `${q}: ${res.text}`).toBe(200);
      expect(res.json.total, q).toBe(0);
    }
    expect(keys(await list("q=5000"))).toEqual(["gpt-5000"]);
  });

  it("provider e author ripetibili", async () => {
    await seedCatalog();
    expect(keys(await list("provider=bedrock"))).toEqual(["claude-sonnet-4-5"]);
    expect(keys(await list("provider=bedrock&provider=deepseek"))).toEqual(["claude-sonnet-4-5", "deepseek-chat"]);
    expect(keys(await list("author=DeepSeek"))).toEqual(["deepseek-chat"]);
    expect(keys(await list("author=DeepSeek&author=OpenAI"))).toEqual(["deepseek-chat", "gpt-5000"]);
    expect((await list("provider=NOPE!")).status).toBe(400);
  });

  it("capacità: true e false letti come booleani", async () => {
    await seedCatalog();
    expect(keys(await list("tools=true"))).toEqual(["claude-sonnet-4-5", "deepseek-chat"]);
    expect(keys(await list("vision=true"))).toEqual(["claude-sonnet-4-5"]);
    expect(keys(await list("vision=false"))).toEqual(["deepseek-chat"]);
    expect(keys(await list("reasoning=true&tools=true"))).toEqual(["claude-sonnet-4-5"]);
    expect((await list("tools=forse")).status).toBe(400);
  });

  it("usable: solo i modelli offerti dal provider di un mio account", async () => {
    await seedCatalog();
    expect(keys(await list("usable=true"))).toEqual(["deepseek-chat"]);
    expect((await list("usable=false")).json.total).toBe(3);
  });

  it("maxPrice sull'offerta più economica, minContext su un'offerta", async () => {
    await seedCatalog();
    expect(keys(await list("maxPrice=1"))).toEqual(["deepseek-chat"]);
    expect(keys(await list("maxPrice=17.5"))).toEqual(["claude-sonnet-4-5", "deepseek-chat"]);
    expect(keys(await list("minContext=500000"))).toEqual(["claude-sonnet-4-5"]);
  });

  it("includeRetired: compaiono le offerte ritirate (e i modelli che hanno solo quelle)", async () => {
    await seedCatalog();
    const res = await list("includeRetired=true&q=claude");
    expect(keys(res)).toEqual(["claude-2", "claude-sonnet-4-5"]);
    expect(res.json.items[0]).toMatchObject({ offerCount: 1, cheapestOffer: { provider: "anthropic", priceInput: 8, priceOutput: 24 } });
  });

  it("ordinamenti: prezzo (senza prezzo in fondo), rilascio e contesto decrescenti", async () => {
    await seedCatalog();
    expect(keys(await list("sort=price"))).toEqual(["deepseek-chat", "claude-sonnet-4-5", "gpt-5000"]);
    expect(keys(await list("sort=released"))).toEqual(["deepseek-chat", "claude-sonnet-4-5", "gpt-5000"]);
    expect(keys(await list("sort=context"))).toEqual(["claude-sonnet-4-5", "deepseek-chat", "gpt-5000"]);
  });

  it("le route sono dietro il login (montate nell'app)", async () => {
    // Senza AUTH_DISABLED l'app risponderebbe 401: qui basta che la route esista
    expect((await api("GET", "/catalog/models", fullBase)).status).toBe(200);
  });
});

describe("offerte di un modello", () => {
  it("ordinate per prezzo (senza prezzo in fondo), con provider, stato e nei miei account", async () => {
    const { claude, deepseek, old } = await seedCatalog();
    const res = await api("GET", `/catalog/models/${claude.id}/offers`);
    expect(res.status, res.text).toBe(200);
    expect(res.json.map((o: { provider: string }) => o.provider)).toEqual(["openrouter", "anthropic", "bedrock", "vertex"]);
    expect(res.json[2]).toEqual({
      id: expect.any(Number),
      provider: "bedrock",
      providerName: "Amazon Bedrock",
      providerStatus: "coming",
      providerModelId: "anthropic.claude-sonnet-4-5-v1:0",
      priceInput: 3,
      priceOutput: 15,
      contextTokens: 200_000,
      supportsTools: null,
      status: "available",
      deprecationDate: null,
      inMyAccounts: false,
    });
    expect(res.json[3]).toMatchObject({ status: "deprecated", deprecationDate: "2027-01-01T00:00:00.000Z", priceInput: null });

    const ds = await api("GET", `/catalog/models/${deepseek.id}/offers`);
    expect(ds.json.map((o: { provider: string; inMyAccounts: boolean }) => [o.provider, o.inMyAccounts])).toEqual([
      ["deepseek", true],
      ["openrouter", false],
    ]);
    // Le offerte ritirate restano visibili nel dettaglio
    expect((await api("GET", `/catalog/models/${old.id}/offers`)).json).toEqual([expect.objectContaining({ status: "retired" })]);
  });

  it("le offerte ritirate in fondo, anche se più economiche", async () => {
    const { claude } = await seedCatalog();
    await db.insert(modelOffersTable).values({
      modelId: claude.id,
      provider: "anthropic",
      providerModelId: "claude-sonnet-4-5-old",
      priceInputPerMtok: "0.1",
      priceOutputPerMtok: "0.1",
      status: "retired",
    });
    const res = await api("GET", `/catalog/models/${claude.id}/offers`);
    expect(res.json.map((o: { providerModelId: string }) => o.providerModelId)).toEqual([
      "anthropic/claude-sonnet-4.5",
      "claude-sonnet-4-5",
      "anthropic.claude-sonnet-4-5-v1:0",
      "claude-sonnet-4-5@20250929",
      "claude-sonnet-4-5-old",
    ]);
  });

  it("modello inesistente → 404", async () => {
    expect((await api("GET", "/catalog/models/999999/offers")).status).toBe(404);
  });
});

describe("provider del catalogo", () => {
  it("conteggio dei modelli (offerte non ritirate) e account dell'utente; senza il vecchio gateway", async () => {
    await seedCatalog();
    const res = await api("GET", "/catalog/providers");
    expect(res.status, res.text).toBe(200);
    const bySlug = new Map(res.json.map((p: { slug: string }) => [p.slug, p]));
    expect(bySlug.has(LEGACY_GATEWAY_PROVIDER)).toBe(false);
    expect(bySlug.get("deepseek")).toEqual({
      slug: "deepseek",
      name: "DeepSeek",
      protocol: "openai_compatible",
      status: "managed",
      origin: "registry",
      firstSeenAt: expect.any(String),
      modelCount: 1,
      hasMyAccount: true,
    });
    // L'account anthropic è di un altro utente; claude-2 è ritirato
    expect(bySlug.get("anthropic")).toMatchObject({ modelCount: 1, hasMyAccount: false });
    expect(bySlug.get("openrouter")).toMatchObject({ modelCount: 3 });
    expect(bySlug.get("groq")).toMatchObject({ modelCount: 0 });
  });

  it("filtri q e status", async () => {
    await seedCatalog();
    const unmanaged = await api("GET", "/catalog/providers?status=unmanaged");
    // Anche il registro ha voci non gestite (protocollo sconosciuto)
    expect(unmanaged.json.map((p: { slug: string }) => p.slug)).toContain(UNMANAGED);
    expect(unmanaged.json.every((p: { status: string }) => p.status === "unmanaged")).toBe(true);
    const q = await api("GET", "/catalog/providers?q=DEEPSEEK");
    expect(q.json.map((p: { slug: string }) => p.slug)).toEqual(["deepseek"]);
    expect((await api("GET", "/catalog/providers?q=%25")).json).toEqual([]);
    expect((await api("GET", "/catalog/providers?status=nope")).status).toBe(400);
  });

  it("issue di un provider non gestito: nome, nomi nelle fonti, voci ed esempi; 404 per gli altri", async () => {
    const { gpt } = await seedCatalog();
    await db.insert(modelOffersTable).values(
      ["n-6", "n-1", "n-3", "n-2", "n-5", "n-4"].map((id) => ({ modelId: gpt.id, provider: UNMANAGED, providerModelId: id })),
    );
    const res = await api("GET", `/catalog/providers/${UNMANAGED}/issue`);
    expect(res.status, res.text).toBe(200);
    expect(res.json.title).toBe("Gestire il provider `Nuovo Provider` in Casello");
    expect(res.json.body).toContain("6 voci");
    expect(res.json.body).toContain("litellm_provider: nuovo_provider");
    expect(res.json.body).toContain("n-1\nn-2\nn-3\nn-4\nn-5\n");
    expect(res.json.body).not.toContain("n-6");

    expect((await api("GET", "/catalog/providers/deepseek/issue")).status).toBe(404);
    expect((await api("GET", "/catalog/providers/inesistente/issue")).status).toBe(404);
  });
});

describe("riepilogo con i provider nuovi", () => {
  it("newProviders nel riepilogo; un riepilogo vecchio senza il campo dà una lista vuota", async () => {
    const base = { firstRun: false, added: [], retired: [], deprecating: [], priceChanged: [], accounts: [] };
    await db.insert(catalogRunsTable).values([
      { trigger: "scheduled", status: "completed", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(), summary: base },
      { trigger: "scheduled", status: "completed", finishedAt: new Date(), summary: { ...base, newProviders: [{ slug: "nuovo", name: "nuovo", count: 3 }] } },
    ]);
    const res = await api("GET", "/catalog/status");
    expect(res.json.latest.summary.newProviders).toEqual([{ slug: "nuovo", name: "nuovo", count: 3 }]);
    await db.delete(catalogRunsTable).where(eq(catalogRunsTable.status, "completed"));
    await db.insert(catalogRunsTable).values({ trigger: "scheduled", status: "completed", finishedAt: new Date(), summary: base });
    expect((await api("GET", "/catalog/status")).json.latest.summary.newProviders).toEqual([]);
  });

  it("un riepilogo non riconosciuto non fa fallire lo stato: riepilogo null", async () => {
    await db.insert(catalogRunsTable).values({ trigger: "scheduled", status: "completed", finishedAt: new Date(), summary: { added: "x", vecchio: 1 } });
    const res = await api("GET", "/catalog/status");
    expect(res.status, res.text).toBe(200);
    expect(res.json.latest).toMatchObject({ status: "completed", summary: null });
  });
  it("voci di accounts che non sono oggetti vengono ignorate (niente 500)", async () => {
    const base = { firstRun: false, added: [], retired: [], deprecating: [], priceChanged: [], newProviders: [] };
    await db.insert(catalogRunsTable).values({ trigger: "scheduled", status: "completed", finishedAt: new Date(), summary: { ...base, accounts: [null, 3, "x"] } });
    const res = await api("GET", "/catalog/status");
    expect(res.status, res.text).toBe(200);
    expect(res.json.latest.summary.accounts).toEqual([]);
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  catalogRunsTable,
  modelOffersTable,
  modelsTable,
  providersTable,
  usersTable,
} from "@workspace/db";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../../test/fake-provider";
import { fakeSourcesFetch, LITELLM_FIXTURE, OPENROUTER_FIXTURE } from "../../../test/fake-sources";
import { encryptSecret } from "../secrets";
import { upsertDiscovered } from "../ai/accounts";
import type { OfferSummary } from "./summary";
import { CatalogBusyError, failInterruptedCatalogRuns, startCatalogRefresh } from "./refresh";

// Aggiornamento del catalogo sul DB di prova (PGlite) con le fonti finte. Gli account deepseek hanno un
// indirizzo non raggiungibile (la verifica fallisce senza rete); quelli `custom` e del provider non gestito
// usano il finto provider.

const KEY = "sk-CHIAVE-DEL-CATALOGO-99";
// I provider di oggi, già in docs/schema-casello.sql: alla fine restano solo loro (DB di prova condiviso)
const TODAY = ["deepseek", "openrouter", "huggingface", "mistral", "groq", "together", "gemini", "custom", "system_gateway"];
const saved: Record<string, string | undefined> = {};
let restoreLoopback: () => void;
let fake: FakeProvider;
let userId: number;

async function cleanup() {
  await pool.query("TRUNCATE users, ai_accounts, catalog_runs RESTART IDENTITY CASCADE");
  // DELETE e non TRUNCATE CASCADE: ai_models fa riferimento alle offerte (set null)
  await pool.query("DELETE FROM model_offers");
  await pool.query("DELETE FROM models");
  await pool.query("DELETE FROM providers WHERE slug <> ALL($1)", [TODAY]);
}

async function deepseekAccount() {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "DeepSeek", provider: "deepseek", baseUrl: "https://127.0.0.1:9/v1", apiKeyEnc: encryptSecret(KEY), status: "ok" })
    .returning();
  return account!;
}

async function offerRow(provider: string, providerModelId: string) {
  const [row] = await db
    .select()
    .from(modelOffersTable)
    .where(and(eq(modelOffersTable.provider, provider), eq(modelOffersTable.providerModelId, providerModelId)));
  return row;
}

async function modelRow(canonicalKey: string) {
  const [row] = await db.select().from(modelsTable).where(eq(modelsTable.canonicalKey, canonicalKey));
  return row;
}

async function runOf(id: number) {
  const [row] = await db.select().from(catalogRunsTable).where(eq(catalogRunsTable.id, id));
  return row!;
}

async function refresh(opts: Parameters<typeof fakeSourcesFetch>[0] = {}) {
  const { run, done } = await startCatalogRefresh({ trigger: "manual", userId, fetchImpl: fakeSourcesFetch(opts) });
  await done;
  return runOf(run.id);
}

beforeAll(() => {
  saved["CASELLO_SECRET_KEY"] = process.env["CASELLO_SECRET_KEY"];
  process.env["CASELLO_SECRET_KEY"] = "b".repeat(64);
  restoreLoopback = allowTestLoopback();
});

afterAll(async () => {
  restoreLoopback();
  if (saved["CASELLO_SECRET_KEY"] === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = saved["CASELLO_SECRET_KEY"];
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  const [user] = await db.insert(usersTable).values({ email: "catalogo@example.com", name: "Catalogo" }).returning();
  userId = user!.id;
  fake = await startFakeProvider({ apiKey: KEY, models: [{ id: "modello-a" }] });
});

afterEach(async () => {
  await fake.close();
  // Nessuna esecuzione lasciata `running` per gli altri file di test
  const running = await db.select().from(catalogRunsTable).where(eq(catalogRunsTable.status, "running"));
  expect(running).toEqual([]);
});

describe("startCatalogRefresh", () => {
  it("scrive modelli, offerte e provider scoperti; arricchisce gli account senza toccare i prezzi manuali", async () => {
    const account = await deepseekAccount();
    await db.insert(aiModelsTable).values([
      { accountId: account.id, modelId: "deepseek-v4-pro", displayName: "V4 Pro", priceInputPerMtok: "9", priceOutputPerMtok: "9", priceSource: "provider", discovered: true },
      { accountId: account.id, modelId: "sconosciuto", displayName: "Altro", priceSource: null, discovered: true },
    ]);
    // Gemini elenca gli id con `models/` e in maiuscolo: si abbinano lo stesso
    const [gemini] = await db
      .insert(aiAccountsTable)
      .values({ userId, name: "Gemini", provider: "gemini", baseUrl: "https://127.0.0.1:9/v1", apiKeyEnc: encryptSecret(KEY), status: "ok" })
      .returning();
    await db.insert(aiModelsTable).values({
      accountId: gemini!.id, modelId: "models/Gemini-3.5-Flash", displayName: "Flash", priceInputPerMtok: "5", priceOutputPerMtok: "6", priceSource: "manual", discovered: true,
    });

    const run = await refresh();
    expect(run).toMatchObject({ status: "completed", error: null, trigger: "manual", userId });
    expect(run.finishedAt).toBeInstanceOf(Date);
    const summary = run.summary as OfferSummary;
    expect(summary.firstRun).toBe(true);
    expect(summary.newProviders).toEqual([{ slug: "nuovo-provider", name: "nuovo_provider", count: 1 }]);

    const v4 = await offerRow("deepseek", "deepseek-v4-pro");
    expect(v4).toMatchObject({
      priceInputPerMtok: "1.450000",
      priceOutputPerMtok: "2.900000",
      priceCachedInputPerMtok: "0.145000",
      supportsTools: true,
      status: "available",
    });
    // Il prezzo di cache viene dalla stessa voce dei prezzi: OpenRouter per l'offerta di OpenRouter
    expect(await offerRow("openrouter", "deepseek/deepseek-chat")).toMatchObject({ priceCachedInputPerMtok: "0.070000" });
    expect(await offerRow("gemini", "gemini-3.5-flash")).toMatchObject({ priceCachedInputPerMtok: "0.030000" });
    expect(await offerRow("gemini", "gemini-2.5-flash")).toMatchObject({ status: "retired" });

    // Lo stesso Claude su Bedrock e su Anthropic: un modello, due offerte
    const claude = await modelRow("claude-sonnet-4-5");
    expect(claude).toMatchObject({ author: "Anthropic", mode: "chat", supportsTools: true, supportsVision: true, supportsReasoning: true });
    const claudeOffers = await db.select().from(modelOffersTable).where(eq(modelOffersTable.modelId, claude!.id));
    expect(claudeOffers.map((o) => o.provider).sort()).toEqual(["anthropic", "bedrock"]);
    // Ogni tipo di modello entra
    expect(await modelRow("text-embedding-3-small")).toMatchObject({ mode: "embedding" });

    // Provider sconosciuto: creato non gestito, con la sua offerta
    const [discovered] = await db.select().from(providersTable).where(eq(providersTable.slug, "nuovo-provider"));
    expect(discovered).toMatchObject({
      name: "nuovo_provider",
      protocol: "unknown",
      status: "unmanaged",
      origin: "discovered",
      defaultBaseUrl: null,
      sourceKeys: { litellm: ["nuovo_provider"], openrouterAuthor: null },
    });
    expect(discovered!.firstSeenAt).toBeInstanceOf(Date);
    expect(await offerRow("nuovo-provider", "modello-x")).toMatchObject({ priceInputPerMtok: "1.000000", priceOutputPerMtok: "2.000000" });

    const models = await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, account.id)).orderBy(aiModelsTable.modelId);
    const byId = new Map(models.map((m) => [m.modelId, m]));
    expect(byId.get("deepseek-v4-pro")).toMatchObject({
      offerId: v4!.id,
      supportsTools: true,
      priceInputPerMtok: "1.450000",
      priceOutputPerMtok: "2.900000",
      priceCachedInputPerMtok: "0.145000",
      priceSource: "catalog",
    });
    expect(byId.get("sconosciuto")).toMatchObject({ offerId: null, priceSource: null });
    const flash = await offerRow("gemini", "gemini-3.5-flash");
    const [flashModel] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, gemini!.id));
    expect(flashModel).toMatchObject({
      offerId: flash!.id,
      supportsTools: true,
      priceInputPerMtok: "5.000000",
      priceOutputPerMtok: "6.000000",
      // Prezzo manuale: quello di cache del catalogo non arriva
      priceCachedInputPerMtok: null,
      priceSource: "manual",
    });

    // Gli account non sono raggiungibili: verifica fallita, niente `missing`
    const [after] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, account.id));
    expect(after!.status).toBe("error");
    expect(summary.accounts).toEqual([]);

    // "Aggiorna modelli" riscrive i prezzi del provider, poi il catalogo li riporta; il manuale resta
    await db.transaction((tx) =>
      upsertDiscovered(tx, account.id, [
        { modelId: "deepseek-v4-pro", displayName: "V4 Pro", contextTokens: null, priceInput: 9, priceOutput: 9, priceCachedInput: 1, priceSource: "provider" },
      ]),
    );
    await db.transaction((tx) =>
      upsertDiscovered(tx, gemini!.id, [
        { modelId: "models/Gemini-3.5-Flash", displayName: "Flash", contextTokens: null, priceInput: 7, priceOutput: 7, priceCachedInput: 1, priceSource: "provider" },
      ]),
    );
    const [v4Again] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.modelId, "deepseek-v4-pro"));
    expect(v4Again).toMatchObject({ priceInputPerMtok: "1.450000", priceCachedInputPerMtok: "0.145000", priceSource: "catalog", offerId: v4!.id });
    const [flashAgain] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, gemini!.id));
    expect(flashAgain).toMatchObject({ priceInputPerMtok: "5.000000", priceCachedInputPerMtok: null, priceSource: "manual", offerId: flash!.id });
  });

  it("al secondo aggiornamento il provider scoperto non si ripete né si modifica", async () => {
    await refresh();
    // Una modifica fatta sul provider scoperto (es. dal registro o a mano) resta
    await db.update(providersTable).set({ name: "Nome scelto" }).where(eq(providersTable.slug, "nuovo-provider"));
    const [before] = await db.select().from(providersTable).where(eq(providersTable.slug, "nuovo-provider"));

    const run = await refresh();
    expect(run.status).toBe("completed");
    const summary = run.summary as OfferSummary;
    expect(summary).toMatchObject({ firstRun: false, newProviders: [], added: [] });
    const rows = await db.select().from(providersTable).where(eq(providersTable.slug, "nuovo-provider"));
    expect(rows).toEqual([before]);
  });

  it("riporta i modelli spariti dall'elenco di un account verificato", async () => {
    const [account] = await db
      .insert(aiAccountsTable)
      .values({ userId, name: "Locale", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret(KEY), status: "ok" })
      .returning();
    await db.insert(aiModelsTable).values([
      { accountId: account!.id, modelId: "modello-a", displayName: "A", discovered: true },
      { accountId: account!.id, modelId: "modello-b", displayName: "B", discovered: true },
      { accountId: account!.id, modelId: "aggiunto-a-mano", displayName: "M", discovered: false },
    ]);

    const run = await refresh();
    expect(run.status).toBe("completed");
    expect((run.summary as OfferSummary).accounts).toEqual([
      { accountId: account!.id, userId, accountName: "Locale", missing: ["modello-b"] },
    ]);
    // Gli account custom non si abbinano al catalogo
    const models = await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, account!.id));
    expect(models.every((m) => m.offerId === null)).toBe(true);
  });

  it("l'account di un provider non gestito si abbina alle offerte di quel provider", async () => {
    await refresh();
    fake.models = [{ id: "modello-x" }, { id: "altro" }];
    const [account] = await db
      .insert(aiAccountsTable)
      .values({ userId, name: "Nuovo", provider: "nuovo-provider", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret(KEY), status: "ok" })
      .returning();

    const run = await refresh();
    expect(run.status).toBe("completed");
    const [after] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, account!.id));
    expect(after!.status).toBe("ok");
    const offer = await offerRow("nuovo-provider", "modello-x");
    const models = new Map(
      (await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, account!.id))).map((m) => [m.modelId, m]),
    );
    expect(models.get("modello-x")).toMatchObject({ offerId: offer!.id, priceInputPerMtok: "1.000000", priceOutputPerMtok: "2.000000", priceSource: "catalog" });
    expect(models.get("altro")).toMatchObject({ offerId: null });
  });

  it("un provider senza elenco dei modelli non riporta modelli spariti", async () => {
    fake.models = null;
    const [account] = await db
      .insert(aiAccountsTable)
      .values({ userId, name: "Senza elenco", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret(KEY), status: "ok" })
      .returning();
    await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "modello-a", displayName: "A", discovered: true });

    const run = await refresh();
    expect(run.status).toBe("completed");
    expect((run.summary as OfferSummary).accounts).toEqual([]);
    const [after] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, account!.id));
    expect(after!.status).toBe("ok");
  });

  it("una fonte in errore: aggiornamento parziale, righe preesistenti intatte", async () => {
    const [old] = await db
      .insert(modelsTable)
      .values({ canonicalKey: "vecchio", author: "DeepSeek", family: "DeepSeek", version: "vecchio" })
      .returning();
    await db.insert(modelOffersTable).values({ modelId: old!.id, provider: "deepseek", providerModelId: "vecchio", priceInputPerMtok: "1" });
    const run = await refresh({ litellm: 500 });
    expect(run).toMatchObject({
      status: "partial",
      error: "aggiornamento parziale: fonte LiteLLM non raggiungibile: dati non aggiornati",
    });
    expect(await offerRow("openrouter", "deepseek/deepseek-v4-pro")).toMatchObject({ priceInputPerMtok: "1.740000", priceOutputPerMtok: "3.480000" });
    expect(await offerRow("deepseek", "vecchio")).toMatchObject({ priceInputPerMtok: "1.000000", modelId: old!.id });
    expect(await modelRow("vecchio")).toMatchObject({ version: "vecchio" });
  });

  it("una fonte in errore: i dati che venivano da quella fonte restano validi, anche quelli del modello", async () => {
    // LiteLLM dà a Gemini 2.5 Flash tipo e visione, che OpenRouter non ha
    const litellm = {
      ...LITELLM_FIXTURE,
      "gemini/gemini-2.5-flash": { ...(LITELLM_FIXTURE["gemini/gemini-2.5-flash"] as object), mode: "responses", supports_vision: true },
    };
    await refresh({ openrouter: OPENROUTER_FIXTURE, litellm });
    const before = await offerRow("gemini", "gemini-2.5-flash");
    expect(before).toMatchObject({ status: "retired" });
    expect(before!.deprecationDate).toBeInstanceOf(Date);
    const modelBefore = await modelRow("gemini-2-5-flash");
    expect(modelBefore).toMatchObject({ mode: "responses", supportsTools: true, supportsVision: true, version: "2.5 Flash" });

    // OpenRouter con un prezzo diverso e senza strumenti: non deve sostituire i dati che venivano da LiteLLM
    const openrouter = {
      data: OPENROUTER_FIXTURE.data.map((m) =>
        m.id === "google/gemini-2.5-flash"
          ? { ...m, pricing: { prompt: "0.000001", completion: "0.000004" }, supported_parameters: ["temperature"] }
          : m,
      ),
    };
    const run = await refresh({ openrouter, litellm: 500 });
    expect(run.status).toBe("partial");
    const after = await offerRow("gemini", "gemini-2.5-flash");
    expect(after).toMatchObject({
      status: "retired",
      deprecationDate: before!.deprecationDate,
      priceInputPerMtok: before!.priceInputPerMtok,
      priceOutputPerMtok: before!.priceOutputPerMtok,
      contextTokens: before!.contextTokens,
      supportsTools: before!.supportsTools,
      sources: before!.sources,
    });
    // L'offerta di OpenRouter si aggiorna; il modello resta com'era
    expect(await offerRow("openrouter", "google/gemini-2.5-flash")).toMatchObject({ priceInputPerMtok: "1.000000", supportsTools: false });
    expect(await modelRow("gemini-2-5-flash")).toEqual(modelBefore);
    const summary = run.summary as OfferSummary;
    expect(summary.priceChanged.filter((c) => c.provider === "gemini" && c.modelId === "gemini-2.5-flash")).toEqual([]);
  });

  it("entrambe le fonti in errore: esecuzione fallita e catalogo invariato", async () => {
    await refresh();
    const offers = await db.select().from(modelOffersTable).orderBy(modelOffersTable.id);
    const models = await db.select().from(modelsTable).orderBy(modelsTable.id);
    const run = await refresh({ openrouter: 500, litellm: 500 });
    expect(run).toMatchObject({
      status: "failed",
      error: "fonte OpenRouter non raggiungibile: dati non aggiornati; fonte LiteLLM non raggiungibile: dati non aggiornati",
    });
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(await db.select().from(modelOffersTable).orderBy(modelOffersTable.id)).toEqual(offers);
    expect(await db.select().from(modelsTable).orderBy(modelsTable.id)).toEqual(models);
  });

  it("riporta i prezzi cambiati al secondo aggiornamento, con la versione del modello", async () => {
    await refresh();
    const litellm = {
      ...LITELLM_FIXTURE,
      "deepseek/deepseek-v4-pro": { ...(LITELLM_FIXTURE["deepseek/deepseek-v4-pro"] as object), input_cost_per_token: 0.000002 },
    };
    const run = await refresh({ openrouter: OPENROUTER_FIXTURE, litellm });
    const summary = run.summary as OfferSummary;
    expect(summary.firstRun).toBe(false);
    expect(summary.priceChanged).toEqual([
      { provider: "deepseek", modelId: "deepseek-v4-pro", version: "V4 Pro", oldInput: 1.45, oldOutput: 2.9, newInput: 2, newOutput: 2.9 },
    ]);
    expect(summary.added).toEqual([]);
  });

  it("scrive le offerte dei provider", async () => {
    await refresh();
    const offers = await db.select().from(modelOffersTable).where(inArray(modelOffersTable.provider, ["deepseek", "openrouter"]));
    expect(offers.length).toBeGreaterThan(0);
  });

  it("una sola esecuzione alla volta", async () => {
    const first = await startCatalogRefresh({ trigger: "manual", userId, fetchImpl: fakeSourcesFetch() });
    expect(first.run.status).toBe("running");
    await expect(startCatalogRefresh({ trigger: "scheduled", userId: null, fetchImpl: fakeSourcesFetch() })).rejects.toBeInstanceOf(
      CatalogBusyError,
    );
    await first.done;
    expect((await runOf(first.run.id)).status).toBe("completed");
  });

  it("failInterruptedCatalogRuns chiude le esecuzioni rimaste aperte e ne consente una nuova", async () => {
    const [stale] = await db.insert(catalogRunsTable).values({ trigger: "scheduled", status: "running" }).returning();
    expect(await failInterruptedCatalogRuns()).toBe(1);
    expect(await runOf(stale!.id)).toMatchObject({ status: "failed", error: "interrotto dal riavvio" });
    expect((await runOf(stale!.id)).finishedAt).toBeInstanceOf(Date);
    expect((await refresh()).status).toBe("completed");
  });

  it("tiene solo le ultime 20 esecuzioni", async () => {
    for (let i = 0; i < 22; i++) await refresh();
    const rows = await db.select().from(catalogRunsTable);
    expect(rows).toHaveLength(20);
    expect(Math.min(...rows.map((r) => r.id))).toBe(3);
  });
});

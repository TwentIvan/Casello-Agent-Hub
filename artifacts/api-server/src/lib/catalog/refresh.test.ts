import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool, aiAccountsTable, aiModelsTable, catalogRunsTable, modelCatalogTable, usersTable } from "@workspace/db";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../../test/fake-provider";
import { fakeSourcesFetch, LITELLM_FIXTURE, OPENROUTER_FIXTURE } from "../../../test/fake-sources";
import { encryptSecret } from "../secrets";
import { upsertDiscovered } from "../ai/accounts";
import type { CatalogSummary } from "./summary";
import { CatalogBusyError, failInterruptedCatalogRuns, startCatalogRefresh } from "./refresh";

// Aggiornamento del catalogo sul DB di prova (PGlite) con le fonti finte. Gli account deepseek hanno un
// indirizzo non raggiungibile (la verifica fallisce senza rete); quello `custom` usa il finto provider.

const KEY = "sk-CHIAVE-DEL-CATALOGO-99";
const saved: Record<string, string | undefined> = {};
let restoreLoopback: () => void;
let fake: FakeProvider;
let userId: number;

async function cleanup() {
  await pool.query("TRUNCATE users, ai_accounts, catalog_runs RESTART IDENTITY CASCADE");
  // DELETE e non TRUNCATE CASCADE: ai_models fa riferimento al catalogo (set null)
  await pool.query("DELETE FROM model_catalog");
}

async function deepseekAccount() {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "DeepSeek", provider: "deepseek", baseUrl: "https://127.0.0.1:9/v1", apiKeyEnc: encryptSecret(KEY), status: "ok" })
    .returning();
  return account!;
}

async function catalogRow(provider: "deepseek" | "gemini", modelId: string) {
  const [row] = await db
    .select()
    .from(modelCatalogTable)
    .where(and(eq(modelCatalogTable.provider, provider), eq(modelCatalogTable.modelId, modelId)));
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
  it("aggiorna il catalogo e arricchisce i modelli degli account, senza toccare i prezzi manuali", async () => {
    const account = await deepseekAccount();
    await db.insert(aiModelsTable).values([
      { accountId: account.id, modelId: "deepseek-v4-pro", displayName: "V4 Pro", priceInputPerMtok: "9", priceOutputPerMtok: "9", priceSource: "provider", discovered: true },
      { accountId: account.id, modelId: "deepseek-chat", displayName: "Chat", priceInputPerMtok: "5", priceOutputPerMtok: "6", priceSource: "manual", discovered: true },
      { accountId: account.id, modelId: "sconosciuto", displayName: "Altro", priceSource: null, discovered: true },
    ]);

    const run = await refresh();
    expect(run).toMatchObject({ status: "completed", error: null, trigger: "manual", userId });
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect((run.summary as CatalogSummary).firstRun).toBe(true);

    const v4 = await catalogRow("deepseek", "deepseek-v4-pro");
    expect(v4).toMatchObject({ priceInputPerMtok: "1.450000", priceOutputPerMtok: "2.900000", supportsTools: true, status: "available" });
    expect(await catalogRow("gemini", "gemini-2.5-flash")).toMatchObject({ status: "retired" });

    const models = await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, account.id)).orderBy(aiModelsTable.modelId);
    const byId = new Map(models.map((m) => [m.modelId, m]));
    expect(byId.get("deepseek-v4-pro")).toMatchObject({
      catalogId: v4!.id,
      supportsTools: true,
      priceInputPerMtok: "1.450000",
      priceOutputPerMtok: "2.900000",
      priceSource: "catalog",
    });
    const chat = await catalogRow("deepseek", "deepseek-chat");
    expect(byId.get("deepseek-chat")).toMatchObject({
      catalogId: chat!.id,
      priceInputPerMtok: "5.000000",
      priceOutputPerMtok: "6.000000",
      priceSource: "manual",
    });
    expect(byId.get("sconosciuto")).toMatchObject({ catalogId: null, priceSource: null });

    // L'account deepseek non è raggiungibile: verifica fallita, niente `missing`
    const [after] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, account.id));
    expect(after!.status).toBe("error");
    expect((run.summary as CatalogSummary).accounts).toEqual([]);

    // "Aggiorna modelli" riscrive i prezzi del provider, poi il catalogo li riporta; il manuale resta
    await db.transaction((tx) =>
      upsertDiscovered(tx, account.id, [
        { modelId: "deepseek-v4-pro", displayName: "V4 Pro", contextTokens: null, priceInput: 9, priceOutput: 9, priceSource: "provider" },
        { modelId: "deepseek-chat", displayName: "Chat", contextTokens: null, priceInput: 7, priceOutput: 7, priceSource: "provider" },
      ]),
    );
    const again = new Map(
      (await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, account.id))).map((m) => [m.modelId, m]),
    );
    expect(again.get("deepseek-v4-pro")).toMatchObject({ priceInputPerMtok: "1.450000", priceSource: "catalog", catalogId: v4!.id });
    expect(again.get("deepseek-chat")).toMatchObject({ priceInputPerMtok: "5.000000", priceSource: "manual" });
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
    expect((run.summary as CatalogSummary).accounts).toEqual([
      { accountId: account!.id, userId, accountName: "Locale", missing: ["modello-b"] },
    ]);
    // Gli account custom non si abbinano al catalogo
    const models = await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, account!.id));
    expect(models.every((m) => m.catalogId === null)).toBe(true);
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
    expect((run.summary as CatalogSummary).accounts).toEqual([]);
    const [after] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, account!.id));
    expect(after!.status).toBe("ok");
  });

  it("una fonte in errore: aggiornamento parziale, righe preesistenti intatte", async () => {
    await db.insert(modelCatalogTable).values({ provider: "deepseek", modelId: "vecchio", family: "DeepSeek", version: "vecchio", priceInputPerMtok: "1" });
    const run = await refresh({ litellm: 500 });
    expect(run).toMatchObject({
      status: "partial",
      error: "aggiornamento parziale: fonte LiteLLM non raggiungibile: dati non aggiornati",
    });
    expect(await catalogRow("deepseek", "deepseek-v4-pro")).toMatchObject({ priceInputPerMtok: "1.740000", priceOutputPerMtok: "3.480000" });
    expect(await catalogRow("deepseek", "vecchio")).toMatchObject({ priceInputPerMtok: "1.000000", version: "vecchio" });
  });

  it("una fonte in errore: i dati che venivano da quella fonte restano validi", async () => {
    await refresh();
    const before = await catalogRow("gemini", "gemini-2.5-flash");
    expect(before).toMatchObject({ status: "retired" });
    expect(before!.deprecationDate).toBeInstanceOf(Date);

    // OpenRouter con un prezzo diverso: non deve sostituire quello che veniva da LiteLLM
    const openrouter = {
      data: OPENROUTER_FIXTURE.data.map((m) =>
        m.id === "google/gemini-2.5-flash" ? { ...m, pricing: { prompt: "0.000001", completion: "0.000004" } } : m,
      ),
    };
    const run = await refresh({ openrouter, litellm: 500 });
    expect(run.status).toBe("partial");
    const after = await catalogRow("gemini", "gemini-2.5-flash");
    expect(after).toMatchObject({
      status: "retired",
      deprecationDate: before!.deprecationDate,
      priceInputPerMtok: before!.priceInputPerMtok,
      priceOutputPerMtok: before!.priceOutputPerMtok,
      contextTokens: before!.contextTokens,
      supportsTools: before!.supportsTools,
      sources: before!.sources,
    });
    const summary = run.summary as CatalogSummary;
    expect(summary.priceChanged.filter((c) => c.provider === "gemini" && c.modelId === "gemini-2.5-flash")).toEqual([]);
  });

  it("entrambe le fonti in errore: esecuzione fallita e catalogo invariato", async () => {
    await refresh();
    const before = await db.select().from(modelCatalogTable).orderBy(modelCatalogTable.id);
    const run = await refresh({ openrouter: 500, litellm: 500 });
    expect(run).toMatchObject({
      status: "failed",
      error: "fonte OpenRouter non raggiungibile: dati non aggiornati; fonte LiteLLM non raggiungibile: dati non aggiornati",
    });
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(await db.select().from(modelCatalogTable).orderBy(modelCatalogTable.id)).toEqual(before);
  });

  it("riporta i prezzi cambiati al secondo aggiornamento", async () => {
    await refresh();
    const litellm = {
      ...LITELLM_FIXTURE,
      "deepseek/deepseek-v4-pro": { ...(LITELLM_FIXTURE["deepseek/deepseek-v4-pro"] as object), input_cost_per_token: 0.000002 },
    };
    const run = await refresh({ openrouter: OPENROUTER_FIXTURE, litellm });
    const summary = run.summary as CatalogSummary;
    expect(summary.firstRun).toBe(false);
    expect(summary.priceChanged).toEqual([
      expect.objectContaining({ provider: "deepseek", modelId: "deepseek-v4-pro", oldInput: 1.45, oldOutput: 2.9, newInput: 2, newOutput: 2.9 }),
    ]);
    expect(summary.added).toEqual([]);
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

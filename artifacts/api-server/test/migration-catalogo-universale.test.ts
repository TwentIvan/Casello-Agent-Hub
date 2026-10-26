import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-catalogo-universale.sql";

describe("migrazione 2026-10-catalogo-universale", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente, con account dei provider di oggi e una voce del catalogo
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-catalogo-universale.sql"));
    await db.exec(`INSERT INTO users (email) VALUES ('ivan@example.com');`);
    await db.exec(`
      INSERT INTO ai_accounts (user_id, name, provider, base_url) SELECT id, 'DeepSeek', 'deepseek', 'https://api.deepseek.com/v1' FROM users;
      INSERT INTO ai_accounts (user_id, name, provider, base_url) SELECT id, 'Mio', 'custom', 'https://llm.example.com/v1' FROM users;
      INSERT INTO ai_accounts (user_id, name, provider, base_url) SELECT id, 'Gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta/openai' FROM users;
      INSERT INTO ai_accounts (user_id, name, provider, base_url) VALUES (NULL, 'Gateway Casello', 'system_gateway', 'https://gw.example.com/v1');
      INSERT INTO model_catalog (provider, model_id, family, version) VALUES ('mistral', 'mistral-large', 'Mistral Large', '2');
      INSERT INTO ai_models (account_id, model_id, display_name, catalog_id) SELECT id, 'deepseek-chat', 'Chat', (SELECT id FROM model_catalog) FROM ai_accounts WHERE name = 'DeepSeek';
      INSERT INTO catalog_runs (trigger, status, finished_at) VALUES ('scheduled', 'completed', now());
    `);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  const accountProviders = async () =>
    (await db.query<{ name: string; provider: string }>("SELECT name, provider FROM ai_accounts ORDER BY id")).rows;

  it("gli account restano con lo stesso provider, ora testo", async () => {
    expect(await accountProviders()).toEqual([
      { name: "DeepSeek", provider: "deepseek" },
      { name: "Mio", provider: "custom" },
      { name: "Gemini", provider: "gemini" },
      { name: "Gateway Casello", provider: "system_gateway" },
    ]);
    const types = (
      await db.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns WHERE column_name = 'provider' AND table_name = 'ai_accounts'`,
      )
    ).rows;
    expect(types).toEqual([{ data_type: "text" }]);
  });

  it("providers contiene i provider di oggi, gestiti e dal registro", async () => {
    const rows = (await db.query<any>("SELECT slug, protocol, status, origin FROM providers ORDER BY slug")).rows;
    expect(rows.map((r: any) => r.slug)).toEqual(
      ["custom", "deepseek", "gemini", "groq", "huggingface", "mistral", "openrouter", "system_gateway", "together"],
    );
    for (const r of rows) expect(r).toMatchObject({ protocol: "openai_compatible", status: "managed", origin: "registry" });
  });

  it("la FK è valida: un account con un provider inesistente è rifiutato", async () => {
    await expect(
      db.exec(`INSERT INTO ai_accounts (name, provider, base_url) VALUES ('X', 'inesistente', 'https://x.example.com/v1')`),
    ).rejects.toThrow(/ai_accounts_provider_providers_slug_fk/);
  });

  it("rinominare uno slug aggiorna gli account (on update cascade)", async () => {
    await db.exec(`BEGIN; UPDATE providers SET slug = 'gemini-x' WHERE slug = 'gemini';`);
    expect((await db.query<any>("SELECT provider FROM ai_accounts WHERE name = 'Gemini'")).rows[0].provider).toBe("gemini-x");
    await db.exec("ROLLBACK;");
  });

  it("modelli e offerte: tabelle vuote, ai_models.offer_id null, vincoli e cascate", async () => {
    expect((await db.query<any>("SELECT count(*)::int AS n FROM models")).rows[0].n).toBe(0);
    expect((await db.query<any>("SELECT offer_id FROM ai_models")).rows).toEqual([{ offer_id: null }]);

    await db.exec(`BEGIN;
      INSERT INTO models (canonical_key, author, family, version, mode) VALUES ('deepseek-chat', 'DeepSeek', 'DeepSeek', 'chat', 'chat');
      INSERT INTO model_offers (model_id, provider, provider_model_id, price_input_per_mtok) SELECT id, 'deepseek', 'deepseek-chat', 0.28 FROM models;
      UPDATE ai_models SET offer_id = (SELECT id FROM model_offers);`);
    try {
      const offer = (await db.query<any>("SELECT status, sources, price_input_per_mtok FROM model_offers")).rows[0];
      expect(offer).toEqual({ status: "available", sources: {}, price_input_per_mtok: "0.280000" });
      // Stesso provider e id presso il provider: rifiutato
      await expect(
        db.exec(`SAVEPOINT s; INSERT INTO model_offers (model_id, provider, provider_model_id) SELECT id, 'deepseek', 'deepseek-chat' FROM models;`),
      ).rejects.toThrow(/model_offers_provider_model_unique/);
      await db.exec("ROLLBACK TO SAVEPOINT s;");
      await expect(
        db.exec(`SAVEPOINT s; INSERT INTO model_offers (model_id, provider, provider_model_id) SELECT id, 'inesistente', 'x' FROM models;`),
      ).rejects.toThrow(/model_offers_provider_providers_slug_fk/);
      await db.exec("ROLLBACK TO SAVEPOINT s;");
      // Eliminare il modello elimina le offerte e lascia ai_models.offer_id null
      await db.exec("DELETE FROM models;");
      expect((await db.query<any>("SELECT count(*)::int AS n FROM model_offers")).rows[0].n).toBe(0);
      expect((await db.query<any>("SELECT offer_id FROM ai_models")).rows).toEqual([{ offer_id: null }]);
    } finally {
      await db.exec("ROLLBACK;");
    }
  });

  it("vecchio catalogo eliminato: model_catalog e ai_models.catalog_id spariti, catalog_runs vuota", async () => {
    const tables = (await db.query<any>("SELECT table_name FROM information_schema.tables WHERE table_name = 'model_catalog'")).rows;
    expect(tables).toEqual([]);
    const cols = (
      await db.query<any>("SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_models' AND column_name = 'catalog_id'")
    ).rows;
    expect(cols).toEqual([]);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM catalog_runs")).rows[0].n).toBe(0);
    // Il modello dell'account resta (perde solo il collegamento al vecchio catalogo)
    expect((await db.query<any>("SELECT model_id FROM ai_models")).rows).toEqual([{ model_id: "deepseek-chat" }]);
  });

  it("è idempotente: una seconda esecuzione non dà errori e non cambia nulla", async () => {
    const before = await accountProviders();
    // Le esecuzioni registrate dopo il deploy non si cancellano più: lo svuotamento vale solo la prima volta
    await db.exec(`INSERT INTO catalog_runs (trigger, status, finished_at) VALUES ('scheduled', 'completed', now())`);
    await db.exec(read(SQL));
    expect(await accountProviders()).toEqual(before);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM catalog_runs")).rows[0].n).toBe(1);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM providers")).rows[0].n).toBe(9);
  });
});

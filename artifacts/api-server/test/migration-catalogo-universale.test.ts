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
      await db.query<{ table_name: string; data_type: string }>(
        `SELECT table_name, data_type FROM information_schema.columns WHERE column_name = 'provider' AND table_name IN ('ai_accounts', 'model_catalog') ORDER BY table_name`,
      )
    ).rows;
    expect(types).toEqual([
      { table_name: "ai_accounts", data_type: "text" },
      { table_name: "model_catalog", data_type: "text" },
    ]);
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
    await expect(
      db.exec(`INSERT INTO model_catalog (provider, model_id, family, version) VALUES ('inesistente', 'm', 'f', '1')`),
    ).rejects.toThrow(/model_catalog_provider_providers_slug_fk/);
  });

  it("rinominare uno slug aggiorna gli account (on update cascade)", async () => {
    await db.exec(`BEGIN; UPDATE providers SET slug = 'gemini-x' WHERE slug = 'gemini';`);
    expect((await db.query<any>("SELECT provider FROM ai_accounts WHERE name = 'Gemini'")).rows[0].provider).toBe("gemini-x");
    await db.exec("ROLLBACK;");
  });

  it("è idempotente: una seconda esecuzione non dà errori e non cambia nulla", async () => {
    const before = await accountProviders();
    await db.exec(read(SQL));
    expect(await accountProviders()).toEqual(before);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM providers")).rows[0].n).toBe(9);
  });
});

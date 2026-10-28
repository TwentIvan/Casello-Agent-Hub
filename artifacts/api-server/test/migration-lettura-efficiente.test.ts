import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-lettura-efficiente.sql";

describe("migrazione 2026-10-lettura-efficiente", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente, con una riga in ognuna delle quattro tabelle
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-lettura-efficiente.sql"));
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('Mister', 'mister', 'http://a');
      INSERT INTO agents (app_id, name) SELECT id, 'Generale' FROM apps;
      INSERT INTO runs (agent_id, prompt_tokens, completion_tokens) SELECT id, 10, 5 FROM agents;
      INSERT INTO analyses (app_id, model, sources, max_tokens, tokens_used)
        SELECT id, 'm', '{"code": "none", "openapi": false, "description": false}', 1000, 100 FROM apps;
      INSERT INTO users (email) VALUES ('ivan@example.com');
      INSERT INTO ai_accounts (user_id, name, provider, base_url) SELECT id, 'DeepSeek', 'deepseek', 'https://api.deepseek.com/v1' FROM users;
      INSERT INTO ai_models (account_id, model_id, display_name, price_input_per_mtok) SELECT id, 'deepseek-chat', 'Chat', 0.28 FROM ai_accounts;
      INSERT INTO models (canonical_key, author, family, version) VALUES ('deepseek-chat', 'DeepSeek', 'DeepSeek', 'chat');
      INSERT INTO model_offers (model_id, provider, provider_model_id, price_input_per_mtok) SELECT id, 'deepseek', 'deepseek-chat', 0.28 FROM models;
    `);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  const columns = async () =>
    (
      await db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE column_name IN ('cached_tokens', 'price_cached_input_per_mtok') ORDER BY table_name, column_name`,
      )
    ).rows;

  it("aggiunge le quattro colonne", async () => {
    expect(await columns()).toEqual([
      { table_name: "ai_models", column_name: "price_cached_input_per_mtok", data_type: "numeric", is_nullable: "YES", column_default: null },
      { table_name: "analyses", column_name: "cached_tokens", data_type: "integer", is_nullable: "NO", column_default: "0" },
      { table_name: "model_offers", column_name: "price_cached_input_per_mtok", data_type: "numeric", is_nullable: "YES", column_default: null },
      { table_name: "runs", column_name: "cached_tokens", data_type: "integer", is_nullable: "NO", column_default: "0" },
    ]);
  });

  it("le righe preesistenti hanno cached_tokens = 0 e prezzo di cache null, il resto intatto", async () => {
    expect((await db.query<any>("SELECT cached_tokens, prompt_tokens FROM runs")).rows).toEqual([{ cached_tokens: 0, prompt_tokens: 10 }]);
    expect((await db.query<any>("SELECT cached_tokens, tokens_used FROM analyses")).rows).toEqual([{ cached_tokens: 0, tokens_used: 100 }]);
    expect((await db.query<any>("SELECT price_cached_input_per_mtok, price_input_per_mtok FROM ai_models")).rows).toEqual([
      { price_cached_input_per_mtok: null, price_input_per_mtok: "0.280000" },
    ]);
    expect((await db.query<any>("SELECT price_cached_input_per_mtok FROM model_offers")).rows).toEqual([{ price_cached_input_per_mtok: null }]);
  });

  it("i nuovi inserimenti senza valore partono da 0", async () => {
    await db.exec(`BEGIN; INSERT INTO runs (agent_id) SELECT id FROM agents;`);
    try {
      expect((await db.query<any>("SELECT cached_tokens FROM runs ORDER BY id DESC LIMIT 1")).rows).toEqual([{ cached_tokens: 0 }]);
    } finally {
      await db.exec("ROLLBACK;");
    }
  });

  it("è idempotente", async () => {
    const before = await columns();
    await db.exec(read(SQL));
    expect(await columns()).toEqual(before);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM runs")).rows[0].n).toBe(1);
  });
});

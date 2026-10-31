import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-pulizia-gateway-post.sql";

describe("migrazione 2026-10-pulizia-gateway-post", () => {
  let db: PGlite;

  beforeEach(async () => {
    // DB proprio: schema attuale + il provider storico, l'enum di produzione e i dati del vecchio gateway
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec(`
      CREATE TYPE "public"."ai_provider" AS ENUM('system_gateway', 'custom');
      INSERT INTO providers (slug, name, protocol, source_keys, status, origin)
        VALUES ('system_gateway', 'Gateway di Casello', 'openai_compatible', '{}', 'managed', 'registry');
      INSERT INTO users (email) VALUES ('ivan@example.com');
      INSERT INTO ai_accounts (id, user_id, name, provider, base_url) VALUES (1, NULL, 'Gateway Casello', 'system_gateway', 'http://gw');
      INSERT INTO ai_accounts (id, user_id, name, provider, base_url)
        SELECT 2, id, 'Mio', 'custom', 'https://llm.example.com/v1' FROM users;
      INSERT INTO ai_models (id, account_id, model_id, display_name) VALUES (10, 1, 'openrouter/auto', 'Auto'), (11, 2, 'm1', 'M1');
      INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com');
      INSERT INTO agents (app_id, name, system_prompt, ai_model_id) SELECT id, 'Agente', 'p', 11 FROM apps;
      INSERT INTO analyses (app_id, model, sources, max_tokens, ai_model_id, cost_usd)
        SELECT id, 'openrouter/auto', '[]', 1000, 10, 1.5 FROM apps;
      INSERT INTO runs (agent_id, ai_model_id, cost_usd) SELECT id, 10, 0.25 FROM agents;
      INSERT INTO plan_conversations (app_id, analysis_id, user_id, ai_model_id, title, cost_usd)
        SELECT a.app_id, a.id, u.id, 10, 'Chat', 0.5 FROM analyses a, users u;
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  const count = async (sql: string) => (await db.query<any>(`SELECT count(*)::int AS n FROM ${sql}`)).rows[0].n;

  it("elimina account e modelli di sistema; analisi e run tengono nome e costo con ai_model_id nullo", async () => {
    await db.exec(read(SQL));
    expect(await count("ai_accounts WHERE provider = 'system_gateway'")).toBe(0);
    expect(await count("ai_models WHERE account_id = 1")).toBe(0);
    expect(await count("providers WHERE slug = 'system_gateway'")).toBe(0);
    expect(await count("pg_type WHERE typname = 'ai_provider'")).toBe(0);
    // l'account personale e il suo modello restano
    expect(await count("ai_accounts WHERE id = 2")).toBe(1);
    expect(await count("ai_models WHERE id = 11")).toBe(1);
    expect((await db.query<any>("SELECT model, ai_model_id, cost_usd::float AS c FROM analyses")).rows).toEqual([
      { model: "openrouter/auto", ai_model_id: null, c: 1.5 },
    ]);
    expect((await db.query<any>("SELECT ai_model_id, cost_usd::float AS c FROM runs")).rows).toEqual([{ ai_model_id: null, c: 0.25 }]);
    expect((await db.query<any>("SELECT ai_model_id, cost_usd::float AS c FROM plan_conversations")).rows).toEqual([
      { ai_model_id: null, c: 0.5 },
    ]);
  });

  it("fallisce senza modifiche se un agente usa un modello di sistema", async () => {
    await db.exec("UPDATE agents SET ai_model_id = 10");
    await expect(db.exec(read(SQL))).rejects.toThrow(/agenti ancora su modelli del gateway/);
    await db.exec("ROLLBACK").catch(() => {});
    expect(await count("ai_accounts WHERE provider = 'system_gateway'")).toBe(1);
    expect(await count("ai_models WHERE account_id = 1")).toBe(1);
    expect(await count("providers WHERE slug = 'system_gateway'")).toBe(1);
    expect(await count("pg_type WHERE typname = 'ai_provider'")).toBe(1);
    expect((await db.query<any>("SELECT ai_model_id FROM runs")).rows).toEqual([{ ai_model_id: 10 }]);
  });

  it("è idempotente", async () => {
    await db.exec(read(SQL));
    await db.exec(read(SQL));
    expect(await count("ai_accounts")).toBe(1);
    expect(await count("providers WHERE slug = 'system_gateway'")).toBe(0);
  });
});

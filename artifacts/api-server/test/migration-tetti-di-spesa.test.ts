import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-tetti-di-spesa.sql";

describe("migrazione 2026-10-tetti-di-spesa", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente, con un agente su un modello, uno sul gateway e una run per ciascuno
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-tetti-di-spesa.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('ivan@example.com');
      INSERT INTO ai_accounts (user_id, name, provider, base_url) SELECT id, 'DeepSeek', 'deepseek', 'https://api.deepseek.com' FROM users;
      INSERT INTO ai_models (account_id, model_id, display_name) SELECT id, 'deepseek-chat', 'Chat' FROM ai_accounts;
      INSERT INTO apps (name, slug, base_url) VALUES ('Mister', 'mister', 'http://a');
      INSERT INTO agents (app_id, name, ai_model_id) SELECT a.id, 'Con modello', m.id FROM apps a, ai_models m;
      INSERT INTO agents (app_id, name) SELECT id, 'Gateway' FROM apps;
      INSERT INTO runs (agent_id) SELECT id FROM agents ORDER BY id;
    `);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  it("le run esistenti prendono il modello del loro agente", async () => {
    expect(
      (await db.query<any>("SELECT a.name, r.ai_model_id IS NOT NULL AS has_model FROM runs r JOIN agents a ON a.id = r.agent_id ORDER BY r.id")).rows,
    ).toEqual([
      { name: "Con modello", has_model: true },
      { name: "Gateway", has_model: false },
    ]);
  });

  it("i tetti partono nulli e accettano due decimali", async () => {
    expect((await db.query<any>("SELECT monthly_budget_usd FROM users")).rows).toEqual([{ monthly_budget_usd: null }]);
    await db.exec(`UPDATE agents SET monthly_budget_usd = 12.5`);
    expect((await db.query<any>("SELECT DISTINCT monthly_budget_usd::text AS v FROM agents")).rows).toEqual([{ v: "12.50" }]);
  });

  it("eliminando il modello la run resta senza modello", async () => {
    await db.exec(`UPDATE agents SET ai_model_id = NULL; DELETE FROM ai_models`);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM runs WHERE ai_model_id IS NOT NULL")).rows[0].n).toBe(0);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM runs")).rows[0].n).toBe(2);
  });

  it("è idempotente", async () => {
    await db.exec(read(SQL));
    await db.exec(read(SQL));
    expect(
      (await db.query<any>("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'runs_ai_model_id_ai_models_id_fk'")).rows[0].n,
    ).toBe(1);
  });
});

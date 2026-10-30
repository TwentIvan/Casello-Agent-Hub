import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-tetti-modello-provider.sql";

describe("migrazione 2026-10-tetti-modello-provider", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente, con un account e un suo modello
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-tetti-modello-provider.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('ivan@example.com');
      INSERT INTO ai_accounts (user_id, name, provider, base_url) SELECT id, 'DeepSeek', 'deepseek', 'https://api.deepseek.com' FROM users;
      INSERT INTO ai_models (account_id, model_id, display_name) SELECT id, 'deepseek-chat', 'Chat' FROM ai_accounts;
    `);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  it("i tetti partono nulli e accettano due decimali", async () => {
    expect((await db.query<any>("SELECT monthly_budget_usd FROM ai_accounts")).rows).toEqual([{ monthly_budget_usd: null }]);
    expect((await db.query<any>("SELECT monthly_budget_usd FROM ai_models")).rows).toEqual([{ monthly_budget_usd: null }]);
    await db.exec(`UPDATE ai_accounts SET monthly_budget_usd = 20; UPDATE ai_models SET monthly_budget_usd = 7.5`);
    expect((await db.query<any>("SELECT monthly_budget_usd::text AS v FROM ai_accounts")).rows).toEqual([{ v: "20.00" }]);
    expect((await db.query<any>("SELECT monthly_budget_usd::text AS v FROM ai_models")).rows).toEqual([{ v: "7.50" }]);
  });

  it("è idempotente e non tocca i tetti già impostati", async () => {
    await db.exec(read(SQL));
    await db.exec(read(SQL));
    expect((await db.query<any>("SELECT monthly_budget_usd::text AS v FROM ai_models")).rows).toEqual([{ v: "7.50" }]);
  });
});

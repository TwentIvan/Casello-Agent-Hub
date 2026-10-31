import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-pulizia-gateway.sql";

describe("migrazione 2026-10-pulizia-gateway", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente, con un utente e un modello di un suo account
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-pulizia-gateway.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('ivan@example.com');
      INSERT INTO ai_accounts (user_id, name, provider, base_url)
        SELECT id, 'Mio', 'custom', 'https://llm.example.com/v1' FROM users;
      INSERT INTO ai_models (account_id, model_id, display_name) SELECT id, 'm1', 'M1' FROM ai_accounts;
    `);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  it("aggiunge la colonna nulla per gli utenti esistenti", async () => {
    expect((await db.query<any>("SELECT default_ai_model_id FROM users")).rows).toEqual([{ default_ai_model_id: null }]);
  });

  it("eliminare il modello predefinito lo toglie (ON DELETE SET NULL)", async () => {
    await db.exec("UPDATE users SET default_ai_model_id = (SELECT id FROM ai_models)");
    expect((await db.query<any>("SELECT default_ai_model_id FROM users")).rows[0].default_ai_model_id).not.toBeNull();
    await db.exec("DELETE FROM ai_models");
    expect((await db.query<any>("SELECT default_ai_model_id FROM users")).rows).toEqual([{ default_ai_model_id: null }]);
    await expect(db.exec("UPDATE users SET default_ai_model_id = 999")).rejects.toThrow();
  });

  it("è idempotente", async () => {
    await db.exec(read(SQL));
    await db.exec(read(SQL));
    expect(
      (await db.query<any>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'default_ai_model_id'")).rows[0].n,
    ).toBe(1);
    expect(
      (await db.query<any>("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'users_default_ai_model_id_ai_models_id_fk'")).rows[0].n,
    ).toBe(1);
  });
});

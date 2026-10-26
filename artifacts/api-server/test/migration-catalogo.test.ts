import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-catalogo-modelli.sql";

describe("migrazione 2026-10-catalogo-modelli", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente al catalogo, con un account e un modello già presenti
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-catalogo.sql"));
    await db.exec(`INSERT INTO users (email) VALUES ('ivan@example.com');`);
    await db.exec(
      `INSERT INTO ai_accounts (user_id, name, provider, base_url) SELECT id, 'DeepSeek', 'deepseek', 'https://api.deepseek.com/v1' FROM users;`,
    );
    await db.exec(`INSERT INTO ai_models (account_id, model_id, display_name) SELECT id, 'deepseek-chat', 'deepseek-chat' FROM ai_accounts;`);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  const addCatalog = async (provider: string, modelId: string) =>
    (
      await db.query<{ id: number }>(
        `INSERT INTO model_catalog (provider, model_id, family, version) VALUES ($1, $2, 'fam', '1') RETURNING id`,
        [provider, modelId],
      )
    ).rows[0]!.id;

  const addRun = (status: string) =>
    db.query(`INSERT INTO catalog_runs (trigger, status) VALUES ('manual', $1)`, [status]);

  it("il modello esistente ha availability unknown e i nuovi campi vuoti", async () => {
    const m = (await db.query<any>("SELECT availability, supports_tools, catalog_id, last_probe_at, last_probe_ok FROM ai_models")).rows[0];
    expect(m).toEqual({ availability: "unknown", supports_tools: null, catalog_id: null, last_probe_at: null, last_probe_ok: null });
  });

  it("accetta un account con provider gemini", async () => {
    await db.exec(
      `INSERT INTO ai_accounts (name, provider, base_url) VALUES ('Gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta/openai')`,
    );
    expect((await db.query("SELECT 1 FROM ai_accounts WHERE provider = 'gemini'")).rows).toHaveLength(1);
  });

  it("model_catalog: (provider, model_id) unico, stato predefinito available", async () => {
    await addCatalog("gemini", "gemini-2.5-flash");
    await expect(addCatalog("gemini", "gemini-2.5-flash")).rejects.toThrow(/model_catalog_provider_model_unique/);
    const row = (await db.query<any>("SELECT status, sources FROM model_catalog")).rows[0];
    expect(row).toEqual({ status: "available", sources: {} });
  });

  it("catalog_runs: una sola esecuzione running alla volta", async () => {
    await addRun("running");
    await expect(addRun("running")).rejects.toThrow(/catalog_runs_one_running/);
    await addRun("completed");
    await addRun("completed");
  });

  it("eliminare una riga del catalogo lascia ai_models.catalog_id null", async () => {
    const c = await addCatalog("deepseek", "deepseek-chat");
    await db.query("UPDATE ai_models SET catalog_id = $1", [c]);
    await db.query("DELETE FROM model_catalog WHERE id = $1", [c]);
    expect((await db.query<any>("SELECT catalog_id FROM ai_models")).rows[0].catalog_id).toBeNull();
  });

  it("catalog_runs.user_id: eliminando l'utente resta null", async () => {
    await db.exec(`INSERT INTO users (email) VALUES ('tmp@example.com')`);
    const u = (await db.query<{ id: number }>("SELECT id FROM users WHERE email = 'tmp@example.com'")).rows[0]!.id;
    await db.query(`INSERT INTO catalog_runs (trigger, status, user_id) VALUES ('manual', 'failed', $1)`, [u]);
    await db.query("DELETE FROM users WHERE id = $1", [u]);
    expect((await db.query("SELECT 1 FROM catalog_runs WHERE user_id IS NOT NULL")).rows).toHaveLength(0);
  });

  it("è idempotente: una seconda esecuzione non cambia nulla", async () => {
    const before = (await db.query("SELECT count(*)::int AS n FROM ai_models")).rows[0];
    await db.exec(read(SQL));
    expect((await db.query("SELECT count(*)::int AS n FROM ai_models")).rows[0]).toEqual(before);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-account-ai.sql";

describe("migrazione 2026-10-account-ai", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente agli Account AI, con utente, app e agente già presenti
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-account-ai.sql"));
    await db.exec(`INSERT INTO users (email) VALUES ('ivan@example.com'), ('altro@example.com');`);
    await db.exec(`INSERT INTO apps (name, slug, base_url) VALUES ('Mister', 'mister', 'http://a');`);
    await db.exec(`INSERT INTO agents (app_id, name) SELECT id, 'Generale' FROM apps;`);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  const userId = async (email: string) =>
    (await db.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email])).rows[0]!.id;

  const addAccount = async (userId: number | null, name: string, isDefault = false) =>
    (
      await db.query<{ id: number }>(
        `INSERT INTO ai_accounts (user_id, name, provider, base_url, is_default) VALUES ($1, $2, 'deepseek', 'https://api.deepseek.com', $3) RETURNING id`,
        [userId, name, isDefault],
      )
    ).rows[0]!.id;

  const addModel = async (accountId: number, modelId: string) =>
    (
      await db.query<{ id: number }>(
        `INSERT INTO ai_models (account_id, model_id, display_name) VALUES ($1, $2, $2) RETURNING id`,
        [accountId, modelId],
      )
    ).rows[0]!.id;

  it("crea le tabelle ai_accounts e ai_models", async () => {
    for (const t of ["ai_accounts", "ai_models"]) {
      const { rows } = await db.query("SELECT to_regclass($1) AS t", [`public.${t}`]);
      expect(rows[0]).toEqual({ t });
    }
  });

  it("aggiunge le colonne ai_model_id e cost_usd", async () => {
    const cols = async (table: string) =>
      (
        await db.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
          [table],
        )
      ).rows.map((r) => r.column_name);
    expect(await cols("agents")).toContain("ai_model_id");
    expect(await cols("analyses")).toEqual(expect.arrayContaining(["ai_model_id", "cost_usd"]));
    expect(await cols("runs")).toContain("cost_usd");
    // l'agente esistente resta senza modello collegato
    expect((await db.query<any>("SELECT ai_model_id FROM agents")).rows[0].ai_model_id).toBeNull();
  });

  it("ai_accounts: un solo account predefinito per utente", async () => {
    const u = await userId("ivan@example.com");
    await addAccount(u, "Primo", true);
    await expect(addAccount(u, "Secondo", true)).rejects.toThrow(/ai_accounts_one_default_per_user/);
    await addAccount(u, "Non predefinito", false);
    await addAccount(await userId("altro@example.com"), "Altro utente", true); // altro utente: ammesso
    await addAccount(null, "Sistema", false); // account di sistema, senza utente
  });

  it("ai_accounts: stato iniziale unverified e provider vincolato dall'enum", async () => {
    const { rows } = await db.query<any>("SELECT status, allow_private_network, api_key_enc FROM ai_accounts LIMIT 1");
    expect(rows[0]).toEqual({ status: "unverified", allow_private_network: false, api_key_enc: null });
    await expect(
      db.query(`INSERT INTO ai_accounts (name, provider, base_url) VALUES ('x', 'altro', 'https://x')`),
    ).rejects.toThrow(/ai_provider/);
  });

  it("ai_models: (account_id, model_id) unico, prezzi numeric letti come stringa", async () => {
    const a = await addAccount(await userId("altro@example.com"), "Per i modelli");
    await addModel(a, "deepseek-chat");
    await expect(addModel(a, "deepseek-chat")).rejects.toThrow(/ai_models_account_model_unique/);
    await db.query(`UPDATE ai_models SET price_input_per_mtok = 0.27, price_source = 'seed' WHERE account_id = $1`, [a]);
    const m = (await db.query<any>("SELECT price_input_per_mtok, price_output_per_mtok FROM ai_models WHERE account_id = $1", [a])).rows[0];
    expect(m.price_input_per_mtok).toBe("0.270000");
    expect(m.price_output_per_mtok).toBeNull();
  });

  it("un modello referenziato da un agente o da un'analisi non si elimina (restrict)", async () => {
    const a = await addAccount(await userId("altro@example.com"), "Con riferimenti");
    const m = await addModel(a, "m-agente");
    await db.query("UPDATE agents SET ai_model_id = $1", [m]);
    await expect(db.query("DELETE FROM ai_models WHERE id = $1", [m])).rejects.toThrow(/agents_ai_model_id_ai_models_id_fk/);
    await db.query("UPDATE agents SET ai_model_id = NULL");

    const m2 = await addModel(a, "m-analisi");
    const appId = (await db.query<{ id: number }>("SELECT id FROM apps")).rows[0]!.id;
    await db.query(
      `INSERT INTO analyses (app_id, model, sources, max_tokens, ai_model_id) VALUES ($1, 'x', '{}', 1000, $2)`,
      [appId, m2],
    );
    await expect(db.query("DELETE FROM ai_models WHERE id = $1", [m2])).rejects.toThrow(/analyses_ai_model_id_ai_models_id_fk/);
  });

  it("eliminando un account si eliminano i suoi modelli; eliminando l'utente i suoi account", async () => {
    await db.exec(`INSERT INTO users (email) VALUES ('cascata@example.com')`);
    const u = await userId("cascata@example.com");
    const a = await addAccount(u, "Cascata");
    await addModel(a, "m-cascata");
    await db.query("DELETE FROM ai_accounts WHERE id = $1", [a]);
    expect((await db.query("SELECT 1 FROM ai_models WHERE model_id = 'm-cascata'")).rows).toHaveLength(0);

    const a2 = await addAccount(u, "Cascata 2");
    await addModel(a2, "m-cascata-2");
    await db.query("DELETE FROM users WHERE id = $1", [u]);
    expect((await db.query("SELECT 1 FROM ai_accounts WHERE id = $1", [a2])).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM ai_models WHERE model_id = 'm-cascata-2'")).rows).toHaveLength(0);
  });

  it("è idempotente: una seconda esecuzione non cambia nulla", async () => {
    const before = (await db.query("SELECT count(*)::int AS n FROM ai_accounts")).rows[0];
    await db.exec(read(SQL));
    expect((await db.query("SELECT count(*)::int AS n FROM ai_accounts")).rows[0]).toEqual(before);
  });
});

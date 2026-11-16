import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-16-architettura-app", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema attuale (docs/schema-casello.sql) con un utente, un'app, un agente e un modello; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('ivan@example.com');
      INSERT INTO apps (name, slug, base_url) VALUES ('Botcave', 'casello', 'https://app.example.com');
      INSERT INTO agents (app_id, name, role) SELECT id, 'Responsabile', 'general' FROM apps;
      INSERT INTO ai_accounts (user_id, name, provider, base_url) SELECT id, 'Conto', 'deepseek', 'https://api.deepseek.com' FROM users;
      INSERT INTO ai_models (account_id, model_id, display_name) SELECT id, 'm', 'm' FROM ai_accounts;
    `);
    await db.exec(read("../../../docs/migrations/2026-11-16-architettura-app.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-16-architettura-app.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("apps.architecture_refresh vale 6h per un'App inserita", async () => {
    const r = await db.query<any>("SELECT architecture_refresh FROM apps");
    expect(r.rows).toEqual([{ architecture_refresh: "6h" }]);
    await expect(db.exec("UPDATE apps SET architecture_refresh = 'mai'")).rejects.toThrow();
  });

  it("crea le tabelle e l'indice", async () => {
    const t = await db.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('app_architecture', 'app_architecture_runs') ORDER BY table_name",
    );
    expect(t.rows.map((r) => r.table_name)).toEqual(["app_architecture", "app_architecture_runs"]);
    const i = await db.query<any>("SELECT indexname FROM pg_indexes WHERE indexname = 'app_architecture_runs_app_created_idx'");
    expect(i.rows).toHaveLength(1);
  });

  it("default della riga di sintesi", async () => {
    await db.exec("INSERT INTO app_architecture (app_id) SELECT id FROM apps");
    const r = await db.query<any>("SELECT status, consecutive_errors, force_requested, sha FROM app_architecture");
    expect(r.rows).toEqual([{ status: "idle", consecutive_errors: 0, force_requested: false, sha: null }]);
  });

  it("FK: SET NULL su agente, modello e utente; CASCADE sull'App", async () => {
    await db.exec(`
      UPDATE app_architecture SET ai_model_id = (SELECT id FROM ai_models LIMIT 1);
      INSERT INTO app_architecture_runs (app_id, agent_id, sha, ai_model_id, user_id)
        SELECT a.id, g.id, 'abc', (SELECT id FROM ai_models LIMIT 1), (SELECT id FROM users LIMIT 1) FROM apps a, agents g;
    `);
    await db.exec("DELETE FROM agents");
    await db.exec("DELETE FROM ai_models");
    await db.exec("DELETE FROM users");
    const run = await db.query<any>("SELECT agent_id, ai_model_id, user_id, summary FROM app_architecture_runs");
    expect(run.rows).toEqual([{ agent_id: null, ai_model_id: null, user_id: null, summary: null }]);
    const arch = await db.query<any>("SELECT ai_model_id FROM app_architecture");
    expect(arch.rows).toEqual([{ ai_model_id: null }]);
    await db.exec("DELETE FROM apps");
    const c = await db.query<any>(
      "SELECT (SELECT count(*) FROM app_architecture)::int AS a, (SELECT count(*) FROM app_architecture_runs)::int AS r",
    );
    expect(c.rows[0]).toEqual({ a: 0, r: 0 });
  });
});

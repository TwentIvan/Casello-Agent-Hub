import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-16-lucius-best-practice", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema precedente alla migrazione: si toglie quanto aggiunto dal file (già riportato in docs/schema-casello.sql) e si ripristina con lo script, due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('ivan@example.com');
      INSERT INTO apps (name, slug, base_url) VALUES ('Botcave', 'casello', 'https://app.example.com');
      INSERT INTO ai_accounts (user_id, name, provider, base_url) SELECT id, 'Conto', 'gemini', 'https://example.com' FROM users;
      INSERT INTO ai_models (account_id, model_id, display_name) SELECT id, 'm', 'm' FROM ai_accounts;
    `);
    await db.exec(read("../../../docs/migrations/2026-11-16-lucius-best-practice.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-16-lucius-best-practice.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("default delle colonne di users", async () => {
    const r = await db.query<any>("SELECT lucius_best_practice, lucius_search_ai_model_id, lucius_sources FROM users");
    expect(r.rows).toEqual([{ lucius_best_practice: "on_request", lucius_search_ai_model_id: null, lucius_sources: [] }]);
  });

  it("l'enum ha i due valori e rifiuta gli altri", async () => {
    const r = await db.query<any>(
      "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'best_practice_mode' ORDER BY e.enumsortorder",
    );
    expect(r.rows.map((x) => x.enumlabel)).toEqual(["always", "on_request"]);
    await expect(db.exec("UPDATE users SET lucius_best_practice = 'mai'")).rejects.toThrow();
  });

  it("le colonne best_practice valgono false di default", async () => {
    await db.exec(`
      INSERT INTO analyses (app_id, model, sources, max_tokens) SELECT id, 'm', '[]'::jsonb, 1000 FROM apps;
      INSERT INTO plan_conversations (app_id, analysis_id, user_id, title) SELECT a.id, (SELECT id FROM analyses LIMIT 1), u.id, 't' FROM apps a, users u;
      INSERT INTO character_conversations (user_id, character, subject_type, title) SELECT id, 'lucius', 'agent', 't' FROM users;
    `);
    for (const t of ["analyses", "plan_conversations", "character_conversations"]) {
      const r = await db.query<any>(`SELECT best_practice FROM ${t}`);
      expect(r.rows, t).toEqual([{ best_practice: false }]);
    }
    const c = await db.query<any>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'team_chat_conversations' AND column_name = 'best_practice'",
    );
    expect(c.rows).toEqual([{ column_name: "best_practice", is_nullable: "NO" }]);
    const n = await db.query<any>("SELECT best_practice_notes FROM analyses");
    expect(n.rows).toEqual([{ best_practice_notes: null }]);
  });

  it("crea best_practice_searches con indice e default", async () => {
    const i = await db.query<any>("SELECT indexname FROM pg_indexes WHERE indexname = 'best_practice_searches_lookup_idx'");
    expect(i.rows).toHaveLength(1);
    await db.exec(`INSERT INTO best_practice_searches (user_id, query_hash, query, answer) SELECT id, 'h', 'q', 'a' FROM users`);
    const r = await db.query<any>("SELECT sources, search_queries, cost_usd, cached_from FROM best_practice_searches");
    expect(r.rows).toEqual([{ sources: [], search_queries: 0, cost_usd: null, cached_from: null }]);
  });

  it("FK: CASCADE su analisi e utente; SET NULL su modello e riga riusata", async () => {
    await db.exec(`
      INSERT INTO best_practice_searches (user_id, analysis_id, query_hash, query, answer, ai_model_id, cached_from)
        SELECT u.id, NULL, 'h2', 'q', 'a', (SELECT id FROM ai_models LIMIT 1), (SELECT min(id) FROM best_practice_searches)
        FROM users u;
      INSERT INTO best_practice_searches (user_id, analysis_id, query_hash, query, answer)
        SELECT u.id, (SELECT id FROM analyses LIMIT 1), 'h3', 'q', 'a' FROM users u;
    `);
    await db.exec("UPDATE users SET lucius_search_ai_model_id = (SELECT id FROM ai_models LIMIT 1)");
    await db.exec("DELETE FROM best_practice_searches WHERE query_hash = 'h'");
    await db.exec("DELETE FROM analyses");
    await db.exec("DELETE FROM ai_models");
    const r = await db.query<any>("SELECT analysis_id, ai_model_id, cached_from FROM best_practice_searches");
    // la riga dell'analisi sparisce con l'analisi, quella di chat resta
    expect(r.rows).toEqual([{ analysis_id: null, ai_model_id: null, cached_from: null }]);
    const u = await db.query<any>("SELECT lucius_search_ai_model_id FROM users");
    expect(u.rows).toEqual([{ lucius_search_ai_model_id: null }]);
    await db.exec("DELETE FROM plan_conversations; DELETE FROM character_conversations");
    await db.exec("DELETE FROM users");
    const c = await db.query<any>("SELECT count(*)::int AS n FROM best_practice_searches");
    expect(c.rows[0]).toEqual({ n: 0 });
  });
});

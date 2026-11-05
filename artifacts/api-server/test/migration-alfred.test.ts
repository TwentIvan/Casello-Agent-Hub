import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-alfred", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema di produzione dopo il connettore OAuth; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-cartelle.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-connettore-oauth.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-alfred.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-alfred.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("crea tabelle, colonne e indice", async () => {
    const t = await db.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('alfred_sessions', 'alfred_confirmations') ORDER BY table_name",
    );
    expect(t.rows.map((r) => r.table_name)).toEqual(["alfred_confirmations", "alfred_sessions"]);
    const c = await db.query<any>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('alfred_ai_model_id', 'alfred_voice') ORDER BY column_name",
    );
    expect(c.rows.map((r) => r.column_name)).toEqual(["alfred_ai_model_id", "alfred_voice"]);
    const i = await db.query<any>("SELECT indexname FROM pg_indexes WHERE indexname = 'alfred_sessions_user_status_idx'");
    expect(i.rows).toHaveLength(1);
  });

  it("eliminare un modello mette a null i riferimenti", async () => {
    await db.exec(`
      INSERT INTO users (email) VALUES ('a@example.com');
      INSERT INTO ai_accounts (user_id, provider, name, base_url) SELECT id, 'deepseek', 'x', 'https://example.com/v1' FROM users;
    `);
    const acc = (await db.query<any>("SELECT id FROM ai_accounts LIMIT 1")).rows[0].id;
    await db.exec(`INSERT INTO ai_models (account_id, model_id, display_name) VALUES (${acc}, 'm1', 'M1')`);
    const model = (await db.query<any>("SELECT id FROM ai_models LIMIT 1")).rows[0].id;
    await db.exec(`
      UPDATE users SET alfred_ai_model_id = ${model};
      INSERT INTO alfred_sessions (user_id, ai_model_id) SELECT id, ${model} FROM users;
    `);
    await db.exec(`DELETE FROM ai_models WHERE id = ${model}`);
    const u = await db.query<any>("SELECT alfred_ai_model_id FROM users");
    expect(u.rows[0].alfred_ai_model_id).toBeNull();
    const s = await db.query<any>("SELECT ai_model_id, status, prompt_tokens, completion_tokens, cost_usd FROM alfred_sessions");
    expect(s.rows).toEqual([{ ai_model_id: null, status: "active", prompt_tokens: 0, completion_tokens: 0, cost_usd: null }]);
  });

  it("le conferme seguono la sessione e lo schema è in schema-casello.sql", async () => {
    await db.exec(`
      INSERT INTO alfred_confirmations (user_id, session_id, number, decision, code_hash, expires_at)
        SELECT user_id, id, 1, 'approve', 'h', now() FROM alfred_sessions;
    `);
    await db.exec("DELETE FROM alfred_sessions");
    const r = await db.query<any>("SELECT count(*)::int AS n FROM alfred_confirmations");
    expect(r.rows[0].n).toBe(0);
    const schema = read("../../../docs/schema-casello.sql");
    expect(schema).toContain('"alfred_sessions"');
    expect(schema).toContain('"alfred_confirmations"');
    expect(schema).toContain('"alfred_voice"');
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-responsabile-ovunque", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema precedente (dopo il nodo locale) con un utente, un'app, un agente e una run; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('ivan@example.com');
      INSERT INTO apps (name, slug, base_url) VALUES ('Botcave', 'casello', 'https://app.example.com');
      INSERT INTO agents (app_id, name, role) SELECT id, 'Responsabile', 'general' FROM apps;
      INSERT INTO runs (agent_id, status) SELECT id, 'pending' FROM agents;
    `);
    await db.exec(read("../../../docs/migrations/2026-11-responsabile-ovunque.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-responsabile-ovunque.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("crea le due tabelle e gli indici", async () => {
    const t = await db.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('lead_conversations', 'lead_messages') ORDER BY table_name",
    );
    expect(t.rows.map((r) => r.table_name)).toEqual(["lead_conversations", "lead_messages"]);
    const i = await db.query<any>(
      "SELECT indexname FROM pg_indexes WHERE indexname IN ('lead_conversations_user_updated_idx', 'lead_messages_conversation_idx') ORDER BY indexname",
    );
    expect(i.rows.map((r) => r.indexname)).toEqual(["lead_conversations_user_updated_idx", "lead_messages_conversation_idx"]);
  });

  it("run eliminata: il messaggio resta senza run; utente eliminato: sparisce tutto", async () => {
    await db.exec(`
      INSERT INTO lead_conversations (user_id, agent_id, title) SELECT u.id, a.id, 'prova' FROM users u, agents a;
      INSERT INTO lead_messages (conversation_id, content, page_context, run_id)
        SELECT c.id, 'ciao', '{"page":"team","id":"1"}', r.id FROM lead_conversations c, runs r;
    `);
    await db.exec("DELETE FROM runs");
    const m = await db.query<any>("SELECT run_id FROM lead_messages");
    expect(m.rows).toEqual([{ run_id: null }]);
    await db.exec("DELETE FROM users");
    const c = await db.query<any>("SELECT (SELECT count(*) FROM lead_conversations)::int AS c, (SELECT count(*) FROM lead_messages)::int AS m");
    expect(c.rows[0]).toEqual({ c: 0, m: 0 });
  });
});

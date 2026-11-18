import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCRIPT = "../../../docs/migrations/2026-11-17-plugin-riordino.sql";

describe("migrazione 2026-11-17-plugin-riordino", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema attuale (docs/schema-casello.sql, che contiene già le modifiche) con dati; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('ivan@example.com');
      INSERT INTO apps (name, slug, base_url) VALUES ('Botcave', 'casello', 'https://app.example.com');
      INSERT INTO apps (name, slug, base_url, lead_name) VALUES ('Altra', 'altra', 'https://altra.example.com', 'Bea');
      INSERT INTO agents (app_id, name, role) SELECT id, 'Responsabile', 'general' FROM apps WHERE slug = 'casello';
      INSERT INTO lead_conversations (user_id, agent_id) SELECT u.id, g.id FROM users u, agents g;
    `);
    // Valori come prima della migrazione: i riempimenti si devono rifare
    await db.exec("UPDATE lead_conversations SET app_id = NULL; UPDATE apps SET lead_name = NULL WHERE slug = 'casello'");
    await db.exec(read(SCRIPT));
    await db.exec(read(SCRIPT));
  });

  afterAll(async () => {
    await db.close();
  });

  it("crea le colonne", async () => {
    const r = await db.query<any>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE (table_name = 'apps' AND column_name IN ('alfred_name', 'lucius_name', 'lead_name', 'page_actions', 'embed_pages_seen'))
          OR (table_name = 'lead_conversations' AND column_name = 'app_id')`,
    );
    expect(r.rows.map((x) => `${x.table_name}.${x.column_name}`).sort()).toEqual([
      "apps.alfred_name",
      "apps.embed_pages_seen",
      "apps.lead_name",
      "apps.lucius_name",
      "apps.page_actions",
      "lead_conversations.app_id",
    ]);
    const d = await db.query<any>("SELECT page_actions, embed_pages_seen FROM apps WHERE slug = 'altra'");
    expect(d.rows).toEqual([{ page_actions: [], embed_pages_seen: [] }]);
  });

  it("riempie app_id e lead_name senza toccare i valori esistenti", async () => {
    const c = await db.query<any>("SELECT c.app_id = a.id AS ok FROM lead_conversations c, apps a WHERE a.slug = 'casello'");
    expect(c.rows).toEqual([{ ok: true }]);
    const a = await db.query<any>("SELECT slug, lead_name FROM apps ORDER BY slug");
    expect(a.rows).toEqual([
      { slug: "altra", lead_name: "Bea" },
      { slug: "casello", lead_name: "Barbara" },
    ]);
  });

  it("plan_proposals: chapter null solo per page_actions", async () => {
    await db.exec(`
      INSERT INTO analyses (app_id, model, sources, max_tokens) SELECT id, 'm', '{}'::jsonb, 1000 FROM apps WHERE slug = 'casello';
      INSERT INTO plan_conversations (app_id, analysis_id, user_id, title)
        SELECT a.app_id, a.id, u.id, 't' FROM analyses a, users u;
      INSERT INTO plan_messages (conversation_id, role, content) SELECT id, 'user', 'x' FROM plan_conversations;
    `);
    await db.exec(
      "INSERT INTO plan_proposals (conversation_id, message_id, kind, chapter, rationale) SELECT c.id, m.id, 'page_actions', NULL, 'r' FROM plan_conversations c, plan_messages m",
    );
    await expect(
      db.exec(
        "INSERT INTO plan_proposals (conversation_id, message_id, kind, chapter, rationale) SELECT c.id, m.id, 'add', NULL, 'r' FROM plan_conversations c, plan_messages m",
      ),
    ).rejects.toThrow();
  });
});

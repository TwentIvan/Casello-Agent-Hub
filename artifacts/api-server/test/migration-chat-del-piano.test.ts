import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-chat-del-piano.sql";

describe("migrazione 2026-10-chat-del-piano", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente, con un'app, un'analisi e una voce esistenti
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-chat-del-piano.sql"));
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('Mister', 'mister', 'http://a');
      INSERT INTO analyses (app_id, model, sources, max_tokens, tokens_used)
        SELECT id, 'm', '{"code": "none", "openapi": false, "description": false}', 1000, 100 FROM apps;
      INSERT INTO analysis_items (analysis_id, chapter, ref, position, payload, diff)
        SELECT id, 'tool', 'tool:a', 0, '{}', 'new' FROM analyses;
      INSERT INTO users (email) VALUES ('ivan@example.com');
    `);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  it("la voce esistente ha origin architect e conversation_id nullo", async () => {
    expect((await db.query<any>("SELECT origin, conversation_id FROM analysis_items")).rows).toEqual([
      { origin: "architect", conversation_id: null },
    ]);
  });

  it("le tabelle nuove accettano conversazione, messaggio e proposta", async () => {
    await db.exec(`
      INSERT INTO plan_conversations (app_id, analysis_id, user_id, title)
        SELECT a.app_id, a.id, u.id, 'Prima chat' FROM analyses a, users u;
      INSERT INTO plan_messages (conversation_id, role, content) SELECT id, 'user', 'ciao' FROM plan_conversations;
      INSERT INTO plan_proposals (conversation_id, message_id, kind, chapter, payload, rationale)
        SELECT conversation_id, id, 'add', 'endpoint', '{}', 'perché' FROM plan_messages;
    `);
    expect((await db.query<any>("SELECT turn_status, tokens_used, cost_usd FROM plan_conversations")).rows).toEqual([
      { turn_status: "idle", tokens_used: 0, cost_usd: null },
    ]);
    expect((await db.query<any>("SELECT role, error, tokens FROM plan_messages")).rows).toEqual([
      { role: "user", error: false, tokens: 0 },
    ]);
    expect((await db.query<any>("SELECT status, item_id, decided_at FROM plan_proposals")).rows).toEqual([
      { status: "pending", item_id: null, decided_at: null },
    ]);
  });

  it("eliminando la conversazione spariscono messaggi e proposte, la voce resta con conversation_id nullo", async () => {
    await db.exec(`UPDATE analysis_items SET origin = 'chat', conversation_id = (SELECT id FROM plan_conversations)`);
    await db.exec(`DELETE FROM plan_conversations`);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM plan_messages")).rows[0].n).toBe(0);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM plan_proposals")).rows[0].n).toBe(0);
    expect((await db.query<any>("SELECT origin, conversation_id FROM analysis_items")).rows).toEqual([
      { origin: "chat", conversation_id: null },
    ]);
  });

  it("è idempotente", async () => {
    await db.exec(read(SQL));
    await db.exec(read(SQL));
    expect((await db.query<any>("SELECT count(*)::int AS n FROM pg_type WHERE typname = 'plan_proposal_status'")).rows[0].n).toBe(1);
  });
});

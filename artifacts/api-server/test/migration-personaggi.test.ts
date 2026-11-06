import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-personaggi", () => {
  let db: PGlite;
  let uid: number;

  beforeAll(async () => {
    // Schema di produzione dopo Lucius sulla squadra; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    for (const f of ["nodo-locale", "nodo-cartelle", "connettore-oauth", "alfred", "lucius-squadra", "personaggi", "personaggi"]) {
      await db.exec(read(`../../../docs/migrations/2026-11-${f}.sql`));
    }
    await db.exec(`INSERT INTO users (email) VALUES ('p@example.com')`);
    uid = (await db.query<any>("SELECT id FROM users WHERE email = 'p@example.com'")).rows[0].id;
  });

  afterAll(async () => {
    await db.close();
  });

  const conv = (type: string, extra = "") =>
    `INSERT INTO character_conversations (user_id, character, subject_type, title${extra ? ", archived_at" : ""}) VALUES (${uid}, 'alfred', '${type}', 't'${extra ? ", " + extra : ""})`;

  it("migration_is_idempotent", async () => {
    // La seconda applicazione è già avvenuta nel beforeAll senza errori: qui una terza
    await db.exec(read("../../../docs/migrations/2026-11-personaggi.sql"));
    const t = await db.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('character_conversations','character_messages','character_proposals') ORDER BY table_name",
    );
    expect(t.rows).toHaveLength(3);
  });

  it("alfred_thread_unique_open", async () => {
    await db.exec(conv("alfred_thread"));
    await expect(db.exec(conv("alfred_thread"))).rejects.toThrow();
    await db.exec(conv("alfred_thread", "now()"));
  });

  it("subject_type_check", async () => {
    await expect(db.exec(conv("boh"))).rejects.toThrow();
  });

  it("proposal_kind_check", async () => {
    const cid = (await db.query<any>("SELECT id FROM character_conversations LIMIT 1")).rows[0].id;
    await db.exec(`INSERT INTO character_messages (conversation_id, role, content) VALUES (${cid}, 'assistant', 'x')`);
    const mid = (await db.query<any>("SELECT id FROM character_messages LIMIT 1")).rows[0].id;
    await db.exec(`INSERT INTO character_proposals (conversation_id, message_id, kind, payload, rationale) VALUES (${cid}, ${mid}, 'handoff', '{}', 'r')`);
    await expect(
      db.exec(`INSERT INTO character_proposals (conversation_id, message_id, kind, payload, rationale) VALUES (${cid}, ${mid}, 'altro', '{}', 'r')`),
    ).rejects.toThrow();
  });

  it("history_kind_has_character_chat", async () => {
    await db.exec(
      `INSERT INTO character_history (user_id, character, kind, ref_id, title, summary) VALUES (${uid}, 'alfred', 'character_chat', 1, 't', 's')`,
    );
  });

  it("users_columns", async () => {
    const r = await db.query<any>(
      "SELECT alfred_chat_ai_model_id, lucius_ai_model_id, alfred_monthly_budget_usd, lucius_monthly_budget_usd FROM users WHERE id = $1",
      [uid],
    );
    expect(r.rows[0]).toEqual({
      alfred_chat_ai_model_id: null,
      lucius_ai_model_id: null,
      alfred_monthly_budget_usd: null,
      lucius_monthly_budget_usd: null,
    });
  });
});

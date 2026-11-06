import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-lucius-squadra", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema di produzione dopo Alfred; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    for (const f of ["nodo-locale", "nodo-cartelle", "connettore-oauth", "alfred", "lucius-squadra", "lucius-squadra"]) {
      await db.exec(read(`../../../docs/migrations/2026-11-${f}.sql`));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  it("crea tabelle, enum, colonne e indici", async () => {
    const t = await db.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('team_chat_conversations','team_chat_messages','team_chat_proposals','character_notes','character_history') ORDER BY table_name",
    );
    expect(t.rows.map((r) => r.table_name)).toEqual([
      "character_history",
      "character_notes",
      "team_chat_conversations",
      "team_chat_messages",
      "team_chat_proposals",
    ]);
    const e = await db.query<any>(
      "SELECT typname FROM pg_type WHERE typname IN ('team_chat_proposal_kind','character','character_history_kind') ORDER BY typname",
    );
    expect(e.rows.map((r) => r.typname)).toEqual(["character", "character_history_kind", "team_chat_proposal_kind"]);
    const c = await db.query<any>(
      "SELECT table_name FROM information_schema.columns WHERE column_name = 'summarized_at' ORDER BY table_name",
    );
    expect(c.rows.map((r) => r.table_name)).toEqual(["plan_conversations", "team_chat_conversations"]);
    const i = await db.query<any>(
      "SELECT indexname FROM pg_indexes WHERE indexname IN ('team_chat_conversations_team_user_idx','character_notes_user_character_idx','character_history_user_character_idx','character_history_ref_uniq')",
    );
    expect(i.rows).toHaveLength(4);
  });

  it("storico unico per conversazione; l'eliminazione dell'utente porta via appunti e storico", async () => {
    await db.exec(`INSERT INTO users (email) VALUES ('l@example.com')`);
    const uid = (await db.query<any>("SELECT id FROM users LIMIT 1")).rows[0].id;
    await db.exec(`
      INSERT INTO character_notes (user_id, character, content) VALUES (${uid}, 'lucius', 'x');
      INSERT INTO character_history (user_id, character, kind, ref_id, title, summary) VALUES (${uid}, 'lucius', 'team_chat', 1, 't', 's');
    `);
    await expect(
      db.exec(`INSERT INTO character_history (user_id, character, kind, ref_id, title, summary) VALUES (${uid}, 'lucius', 'team_chat', 1, 't2', 's2')`),
    ).rejects.toThrow();
    await db.exec(`DELETE FROM users WHERE id = ${uid}`);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM character_notes")).rows[0].n).toBe(0);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM character_history")).rows[0].n).toBe(0);
  });

  it("lo schema è in schema-casello.sql", () => {
    const schema = read("../../../docs/schema-casello.sql");
    for (const n of ["team_chat_conversations", "team_chat_messages", "team_chat_proposals", "character_notes", "character_history"]) {
      expect(schema).toContain(`"${n}"`);
    }
  });
});

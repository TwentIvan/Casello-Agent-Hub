import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-ferma-accoda", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema di produzione prima di Ferma e Accoda; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    for (const f of [
      "nodo-locale", "nodo-cartelle", "connettore-oauth", "alfred", "lucius-squadra", "personaggi",
      "plugin-incorporabile", "squadre-esecuzione", "proposte-multiple", "inneschi",
      "esecutore-nodo", "nodo-senza-terminale", "ferma-accoda", "ferma-accoda",
    ]) {
      await db.exec(read(`../../../docs/migrations/2026-11-${f}.sql`));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  it("migration_is_idempotent", async () => {
    await db.exec(read("../../../docs/migrations/2026-11-ferma-accoda.sql"));
    const r = await db.query<any>(
      "SELECT table_name FROM information_schema.columns WHERE column_name = 'queued_at' AND table_name IN ('character_messages','plan_messages','team_chat_messages') ORDER BY table_name",
    );
    expect(r.rows.map((x) => x.table_name)).toEqual(["character_messages", "plan_messages", "team_chat_messages"]);
  });

  it("one_queued_per_conversation", async () => {
    const u = (await db.query<any>("INSERT INTO users (email) VALUES ('q@example.com') RETURNING id")).rows[0].id;
    const c = (
      await db.query<any>(
        `INSERT INTO character_conversations (user_id, character, subject_type, title) VALUES (${u}, 'lucius', 'skill', 't') RETURNING id`,
      )
    ).rows[0].id;
    const ins = (queued: boolean) =>
      db.exec(
        `INSERT INTO character_messages (conversation_id, role, content${queued ? ", queued_at" : ""}) VALUES (${c}, 'user', 'x'${queued ? ", now()" : ""})`,
      );
    await ins(false);
    await ins(false);
    await ins(true);
    await expect(ins(true)).rejects.toThrow();
  });
});

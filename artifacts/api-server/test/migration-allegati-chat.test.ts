import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCRIPT = "../../../docs/migrations/2026-11-24-allegati-chat.sql";

describe("migrazione 2026-11-24-allegati-chat", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema attuale senza la tabella e le colonne nuove: lo script si applica due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec(`DROP TABLE IF EXISTS chat_attachments;
      ALTER TABLE model_offers DROP COLUMN IF EXISTS supports_vision;
      ALTER TABLE model_offers DROP COLUMN IF EXISTS supports_pdf;`);
    await db.exec(read(SCRIPT));
    await db.exec(read(SCRIPT));
    await db.exec("INSERT INTO users (email) VALUES ('ivan@example.com')");
    await db.exec("INSERT INTO apps (name, slug, base_url) VALUES ('A', 'a', 'https://a.example.com')");
    await db.exec("INSERT INTO analyses (app_id, model, sources, max_tokens) VALUES (1, 'm', '{}'::jsonb, 1000)");
    await db.exec("INSERT INTO plan_conversations (app_id, analysis_id, user_id, title) VALUES (1, 1, 1, 't')");
  });

  afterAll(async () => {
    await db.close();
  });

  it("salva un allegato di una chat del piano e lo lega al messaggio", async () => {
    await db.exec(`INSERT INTO chat_attachments (user_id, conversation_kind, plan_conversation_id, name, content_type, size_bytes, sha256, content)
      VALUES (1, 'plan_chat', 1, 'a.png', 'image/png', 3, 'x', '\\x010203')`);
    await db.exec("UPDATE chat_attachments SET message_id = 7");
    const r = await db.query<any>("SELECT conversation_kind, message_id, size_bytes FROM chat_attachments");
    expect(r.rows).toEqual([{ conversation_kind: "plan_chat", message_id: 7, size_bytes: 3 }]);
  });

  it("la colonna della conversazione deve essere quella del tipo", async () => {
    await expect(
      db.exec(`INSERT INTO chat_attachments (user_id, conversation_kind, plan_conversation_id, name, content_type, size_bytes, sha256, content)
        VALUES (1, 'character', 1, 'a.png', 'image/png', 3, 'x', '\\x01')`),
    ).rejects.toThrow();
  });

  it("le offerte hanno visione e PDF; eliminando la conversazione gli allegati spariscono", async () => {
    const cols = await db.query<any>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'model_offers' AND column_name IN ('supports_vision', 'supports_pdf') ORDER BY 1",
    );
    expect(cols.rows.map((c: { column_name: string }) => c.column_name)).toEqual(["supports_pdf", "supports_vision"]);
    await db.exec("DELETE FROM plan_conversations");
    expect((await db.query<any>("SELECT count(*)::int AS n FROM chat_attachments")).rows[0].n).toBe(0);
  });
});

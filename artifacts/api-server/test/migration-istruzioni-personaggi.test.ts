import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-17-istruzioni-personaggi", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema precedente alla migrazione: si tolgono tabelle ed enum aggiunti (già riportati in docs/schema-casello.sql) e si ripristinano con lo script, due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    // chat_attachments (allegati delle chat, migrazione successiva) usa l'enum instruction_conversation_kind
    await db.exec(`
      DROP TABLE chat_attachments;
      DROP TABLE character_instructions;
      DROP TABLE character_instruction_proposals;
      DROP TYPE character_instruction_source;
      DROP TYPE instruction_conversation_kind;
      DROP TYPE instruction_proposal_status;
      INSERT INTO users (email) VALUES ('ivan@example.com');
    `);
    await db.exec(read("../../../docs/migrations/2026-11-17-istruzioni-personaggi.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-17-istruzioni-personaggi.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("gli enum hanno i valori attesi", async () => {
    const q = async (t: string) =>
      (
        await db.query<any>(
          "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder",
          [t],
        )
      ).rows.map((x) => x.enumlabel);
    expect(await q("character_instruction_source")).toEqual(["manual", "proposal", "restore"]);
    expect(await q("instruction_conversation_kind")).toEqual(["character", "plan_chat", "team_chat"]);
    expect(await q("instruction_proposal_status")).toEqual(["pending", "accepted", "rejected", "stale"]);
  });

  it("due versioni uguali per utente e personaggio sono rifiutate, personaggi diversi no", async () => {
    await db.exec(`INSERT INTO character_instructions (user_id, character, version, content, source) SELECT id, 'lucius', 1, 'a', 'manual' FROM users`);
    await expect(
      db.exec(`INSERT INTO character_instructions (user_id, character, version, content, source) SELECT id, 'lucius', 1, 'b', 'manual' FROM users`),
    ).rejects.toThrow(/unique|duplicate/i);
    await db.exec(`INSERT INTO character_instructions (user_id, character, version, content, source) SELECT id, 'alfred', 1, 'b', 'manual' FROM users`);
  });

  it("version = 0 viola il CHECK", async () => {
    await expect(
      db.exec(`INSERT INTO character_instructions (user_id, character, version, content, source) SELECT id, 'lucius', 0, 'x', 'manual' FROM users`),
    ).rejects.toThrow(/check/i);
  });

  it("la proposta ha stato pending di default e l'indice di conversazione", async () => {
    await db.exec(`
      INSERT INTO character_instruction_proposals (user_id, character, conversation_kind, conversation_id, base_version, content, reason)
        SELECT id, 'lucius', 'plan_chat', 1, 1, 'nuove', 'perché' FROM users`);
    const r = await db.query<any>("SELECT status, message_id, decided_at FROM character_instruction_proposals");
    expect(r.rows).toEqual([{ status: "pending", message_id: null, decided_at: null }]);
    const i = await db.query<any>("SELECT indexname FROM pg_indexes WHERE indexname = 'character_instruction_proposals_conv_idx'");
    expect(i.rows).toHaveLength(1);
  });

  it("eliminare la proposta mette proposal_id a null; eliminare l'utente cancella tutto", async () => {
    await db.exec(`INSERT INTO character_instructions (user_id, character, version, content, source, proposal_id)
      SELECT u.id, 'lucius', 2, 'c', 'proposal', (SELECT id FROM character_instruction_proposals LIMIT 1) FROM users u`);
    await db.exec("DELETE FROM character_instruction_proposals");
    const r = await db.query<any>("SELECT proposal_id FROM character_instructions WHERE version = 2");
    expect(r.rows).toEqual([{ proposal_id: null }]);
    await db.exec(`INSERT INTO character_instruction_proposals (user_id, character, conversation_kind, conversation_id, base_version, content, reason)
      SELECT id, 'alfred', 'character', 1, 0, 'n', 'r' FROM users`);
    await db.exec("DELETE FROM users");
    const c = await db.query<any>(
      "SELECT (SELECT count(*) FROM character_instructions)::int AS i, (SELECT count(*) FROM character_instruction_proposals)::int AS p",
    );
    expect(c.rows[0]).toEqual({ i: 0, p: 0 });
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCRIPT = "../../../docs/migrations/2026-11-24-istruzioni-run.sql";

describe("migrazione 2026-11-24-istruzioni-run", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema attuale senza la tabella nuova: lo script si applica due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec("DROP TABLE IF EXISTS run_messages; DROP TYPE IF EXISTS run_message_status;");
    await db.exec(read(SCRIPT));
    await db.exec(read(SCRIPT));
    await db.exec("INSERT INTO users (email) VALUES ('ivan@example.com')");
    await db.exec("INSERT INTO apps (name, slug, base_url) VALUES ('A', 'a', 'https://a.example.com')");
    await db.exec("INSERT INTO agents (app_id, name, system_prompt, role) VALUES (1, 'Ag', 'p', 'area')");
    await db.exec("INSERT INTO runs (agent_id, input) VALUES (1, 'x')");
  });

  afterAll(async () => {
    await db.close();
  });

  it("salva un messaggio in attesa e lo segna consegnato", async () => {
    await db.exec("INSERT INTO run_messages (run_id, user_id, content) VALUES (1, 1, 'cambia strada')");
    await db.exec("UPDATE run_messages SET status = 'delivered', delivered_at = now()");
    const r = await db.query<any>("SELECT status, content FROM run_messages");
    expect(r.rows).toEqual([{ status: "delivered", content: "cambia strada" }]);
  });

  it("eliminando l'utente il messaggio resta senza autore; eliminando la run sparisce", async () => {
    await db.exec("DELETE FROM users");
    expect((await db.query<any>("SELECT user_id FROM run_messages")).rows).toEqual([{ user_id: null }]);
    await db.exec("DELETE FROM runs");
    expect((await db.query<any>("SELECT count(*)::int AS n FROM run_messages")).rows[0].n).toBe(0);
  });
});

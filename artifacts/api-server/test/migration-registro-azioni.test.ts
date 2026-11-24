import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCRIPT = "../../../docs/migrations/2026-11-24-registro-azioni.sql";

describe("migrazione 2026-11-24-registro-azioni", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema attuale senza la tabella nuova: lo script si applica due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec("DROP TABLE IF EXISTS audit_events;");
    await db.exec("INSERT INTO users (email) VALUES ('ivan@example.com')");
    await db.exec(read(SCRIPT));
    await db.exec(read(SCRIPT));
  });

  afterAll(async () => {
    await db.close();
  });

  it("salva un evento con i valori predefiniti", async () => {
    await db.exec(`INSERT INTO audit_events (user_id, action, object_type, object_id, detail, via, ip)
      SELECT id, 'api_token.create', 'api_token', '7', '{"scopes":["mcp"]}', 'session', '203.0.113.5' FROM users LIMIT 1`);
    const r = await db.query<any>("SELECT action, via, created_at FROM audit_events");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].action).toBe("api_token.create");
    expect(r.rows[0].created_at).toBeInstanceOf(Date);
  });

  it("eliminando l'utente si eliminano i suoi eventi", async () => {
    await db.exec("DELETE FROM users");
    const r = await db.query<any>("SELECT count(*)::int AS n FROM audit_events");
    expect(r.rows[0].n).toBe(0);
  });
});

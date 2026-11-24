import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCRIPT = "../../../docs/migrations/2026-11-24-rate-limit-persistente.sql";

describe("migrazione 2026-11-24-rate-limit-persistente", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema attuale senza la tabella nuova: lo script si applica due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec("DROP TABLE IF EXISTS rate_limit_counters;");
    await db.exec("INSERT INTO users (email) VALUES ('ivan@example.com')");
    await db.exec(read(SCRIPT));
    await db.exec(read(SCRIPT));
  });

  afterAll(async () => {
    await db.close();
  });

  it("conta con l'upsert sulla chiave (utente, contatore, finestra)", async () => {
    const upsert = `INSERT INTO rate_limit_counters (user_id, bucket, window_start, count)
      SELECT id, 'run_start', '2026-11-24T10:00:00Z', 1 FROM users LIMIT 1
      ON CONFLICT (user_id, bucket, window_start) DO UPDATE SET count = rate_limit_counters.count + 1 RETURNING count`;
    expect((await db.query<any>(upsert)).rows[0].count).toBe(1);
    expect((await db.query<any>(upsert)).rows[0].count).toBe(2);
  });

  it("eliminando l'utente si eliminano i suoi contatori", async () => {
    await db.exec("DELETE FROM users");
    const r = await db.query<any>("SELECT count(*)::int AS n FROM rate_limit_counters");
    expect(r.rows[0].n).toBe(0);
  });
});

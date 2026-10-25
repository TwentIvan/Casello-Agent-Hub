import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

// Protegge l'infrastruttura di test: il global setup deve esporre DATABASE_URL ai worker
// prima che @workspace/db venga importato, e il Postgres di prova deve accettare query.
describe("database di test", () => {
  it("risponde a select 1", async () => {
    const res = await pool.query("select 1 as ok");
    expect(res.rows[0].ok).toBe(1);
  });

  it("ha lo schema di Casello", async () => {
    const res = await pool.query("select count(*)::int as n from apps");
    expect(res.rows[0].n).toBe(0);
  });
});

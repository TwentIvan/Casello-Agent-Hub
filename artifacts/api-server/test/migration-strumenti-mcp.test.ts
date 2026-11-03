import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-11-strumenti-mcp.sql";

describe("migrazione 2026-11-strumenti-mcp", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente, con quattro tool dalle combinazioni dei due flag
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-strumenti-mcp.sql"));
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com');
      INSERT INTO app_tools (app_id, name, kind, read_only, requires_confirmation, definition)
        SELECT id, v.n, 'http', v.ro, v.rc, '{}'::jsonb FROM apps,
        (VALUES ('ro', true, false), ('rc', false, true), ('both', true, true), ('none', false, false)) AS v(n, ro, rc);
    `);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  const levels = async () =>
    Object.fromEntries(
      (await db.query<any>("SELECT name, level FROM app_tools ORDER BY name")).rows.map((r) => [r.name, r.level]),
    );

  it("travasa i flag nei livelli", async () => {
    expect(await levels()).toEqual({ ro: "L0", rc: "L2", both: "L2", none: "L1" });
    expect((await db.query<any>("SELECT level_override FROM app_tools")).rows.every((r) => r.level_override === null)).toBe(true);
  });

  it("crea mcp_url e pending_actions con l'unico su utente + numero", async () => {
    expect((await db.query<any>("SELECT mcp_url FROM apps")).rows).toEqual([{ mcp_url: null }]);
    await db.exec(`INSERT INTO users (email) VALUES ('a@example.com')`);
    const ins = `INSERT INTO pending_actions (user_id, number, app_id, tool_id, args_enc, args_public, recipient, summary)
      SELECT u.id, 1, a.id, t.id, 'x', '{}'::jsonb, 'r', 's' FROM users u, apps a, app_tools t WHERE t.name = 'ro'`;
    await db.exec(ins);
    await expect(db.exec(ins)).rejects.toThrow(/unique/i);
    expect((await db.query<any>("SELECT status FROM pending_actions")).rows).toEqual([{ status: "pending" }]);
  });

  it("elimina un tool con azioni in coda: rifiutato (FK RESTRICT)", async () => {
    await expect(db.exec("DELETE FROM app_tools WHERE name = 'ro'")).rejects.toThrow(/foreign key|violates/i);
    expect((await db.query<any>("SELECT 1 FROM app_tools WHERE name = 'ro'")).rows).toHaveLength(1);
  });

  it("accetta il tipo mcp", async () => {
    await db.exec(`INSERT INTO app_tools (app_id, name, kind, definition) SELECT id, 'm', 'mcp', '{}'::jsonb FROM apps`);
    expect((await levels()).m).toBe("L2");
  });

  it("è idempotente e non ricalcola i livelli già impostati", async () => {
    await db.exec("UPDATE app_tools SET level = 'L3' WHERE name = 'ro'");
    await db.exec(read(SQL));
    await db.exec(read(SQL));
    expect((await levels()).ro).toBe("L3");
    expect(
      (await db.query<any>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'app_tools' AND column_name = 'level'")).rows[0].n,
    ).toBe(1);
  });
});

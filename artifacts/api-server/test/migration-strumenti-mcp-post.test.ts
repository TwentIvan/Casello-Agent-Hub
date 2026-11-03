import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-strumenti-mcp-post", () => {
  let db: PGlite;

  const columns = async (table: string) =>
    (await db.query<any>("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [table])).rows.map(
      (r) => r.column_name as string,
    );

  beforeAll(async () => {
    // DB proprio: schema precedente, script additivo e poi lo script distruttivo
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-strumenti-mcp.sql"));
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com');
      INSERT INTO app_tools (app_id, name, kind, read_only, requires_confirmation, definition)
        SELECT id, v.n, 'http', v.ro, v.rc, '{}'::jsonb FROM apps,
        (VALUES ('ro', true, false), ('rc', false, true)) AS v(n, ro, rc);
    `);
    await db.exec(read("../../../docs/migrations/2026-11-strumenti-mcp.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("prima del -post le cinque colonne esistono ancora", async () => {
    expect(await columns("app_tools")).toEqual(expect.arrayContaining(["requires_confirmation", "read_only"]));
    expect(await columns("runs")).toEqual(expect.arrayContaining(["pending_action", "loop_state", "paused_at"]));
  });

  it("toglie le cinque colonne e lascia i livelli; una seconda esecuzione non fallisce", async () => {
    const sql = read("../../../docs/migrations/2026-11-strumenti-mcp-post.sql");
    await db.exec(sql);
    await db.exec(sql);
    const tools = await columns("app_tools");
    const runs = await columns("runs");
    for (const c of ["requires_confirmation", "read_only"]) expect(tools).not.toContain(c);
    for (const c of ["pending_action", "loop_state", "paused_at"]) expect(runs).not.toContain(c);
    expect(tools).toEqual(expect.arrayContaining(["level", "level_override"]));
    expect((await db.query<any>("SELECT name, level FROM app_tools ORDER BY name")).rows).toEqual([
      { name: "rc", level: "L2" },
      { name: "ro", level: "L0" },
    ]);
  });
});

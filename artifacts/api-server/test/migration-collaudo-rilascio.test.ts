import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCRIPT = "../../../docs/migrations/2026-11-26-collaudo-rilascio.sql";

describe("migrazione 2026-11-26-collaudo-rilascio", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    // Lo script si applica due volte, anche sopra lo schema che già lo contiene
    await db.exec(read(SCRIPT));
    await db.exec(read(SCRIPT));
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com');
      INSERT INTO team_instances (name, ref_app_id, ref_type, ref_id, ref_title, roles)
        VALUES ('Squadra', (SELECT id FROM apps LIMIT 1), 'piano', '1', 'Piano', '[]');
      INSERT INTO team_works (instance_id, number, repo, branch, base_branch, base_sha)
        VALUES ((SELECT id FROM team_instances LIMIT 1), 1, 'o/r', 'botcave/lavoro-1-1', 'main', 'abc');
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  const insert = (status: string) =>
    db.exec(`INSERT INTO release_tests (app_id, work_id, instance_id, sha, status)
      SELECT a.id, w.id, w.instance_id, 'abc', '${status}' FROM apps a, team_works w LIMIT 1`);

  it("due collaudi aperti per la stessa App violano l'indice unico", async () => {
    await insert("queued");
    await expect(insert("queued")).rejects.toThrow(/release_tests_one_open_per_app/);
    await expect(insert("running")).rejects.toThrow(/release_tests_one_open_per_app/);
  });

  it("un collaudo chiuso e uno aperto per la stessa App convivono", async () => {
    await insert("done");
    await insert("failed");
    const r = await db.query<any>("SELECT status FROM release_tests ORDER BY id");
    expect(r.rows.map((x) => x.status)).toEqual(["queued", "done", "failed"]);
  });

  it("i valori predefiniti delle colonne nuove", async () => {
    const a = await db.query<any>("SELECT test_recipe, test_recipe_version, test_auto_fix FROM apps");
    expect(a.rows[0]).toEqual({ test_recipe: null, test_recipe_version: 0, test_auto_fix: false });
    const w = await db.query<any>("SELECT test_auto_rejects FROM team_works");
    expect(w.rows[0].test_auto_rejects).toBe(0);
  });

  it("eliminando la squadra spariscono collaudi, comandi e file; versioni di ricetta uniche per App", async () => {
    await db.exec(`INSERT INTO release_test_commands (test_id, kind) SELECT id, 'x' FROM release_tests LIMIT 1`);
    await db.exec(`INSERT INTO release_test_files (test_id, kind, name, content_type, size, sha256, content)
      SELECT id, 'screenshot', 'a.png', 'image/png', 1, 'h', '\\x00' FROM release_tests LIMIT 1`);
    await db.exec(`INSERT INTO app_test_recipes (app_id, version, recipe, source) SELECT id, 1, '{}', 'user' FROM apps`);
    await expect(
      db.exec(`INSERT INTO app_test_recipes (app_id, version, recipe, source) SELECT id, 1, '{}', 'agent' FROM apps`),
    ).rejects.toThrow();
    await db.exec("DELETE FROM team_instances");
    for (const t of ["release_tests", "release_test_commands", "release_test_files"]) {
      const r = await db.query<any>(`SELECT count(*)::int AS n FROM ${t}`);
      expect(r.rows[0].n, t).toBe(0);
    }
  });
});

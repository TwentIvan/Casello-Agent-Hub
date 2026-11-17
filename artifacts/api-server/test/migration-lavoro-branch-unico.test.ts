import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const MIGRATION = "../../../docs/migrations/2026-11-17-lavoro-branch-unico.sql";

describe("migrazione 2026-11-17-lavoro-branch-unico", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema attuale con un'App, una squadra e un compito con codice già esistenti; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('The Hub Up', 'thehubup', 'https://app.example.com');
      INSERT INTO team_instances (name, ref_app_id, ref_type, ref_id, ref_title) SELECT 'Squadra', id, 'piano', '1', 'Piano' FROM apps;
      INSERT INTO team_code_tasks (instance_id, plan_task_id, repo, branch, base_branch) SELECT id, 't1', 'o/r', 'botcave/1-t1', 'main' FROM team_instances;
    `);
    await db.exec(read(MIGRATION));
    await db.exec(read(MIGRATION));
  });

  afterAll(async () => {
    await db.close();
  });

  it("App e compiti esistenti restano senza versione di prova né lavoro", async () => {
    const a = await db.query<any>("SELECT staging_branch, staging_url FROM apps");
    expect(a.rows).toEqual([{ staging_branch: null, staging_url: null }]);
    const c = await db.query<any>("SELECT work_id FROM team_code_tasks");
    expect(c.rows).toEqual([{ work_id: null }]);
  });

  it("al più un lavoro non chiuso per squadra, numero unico per squadra", async () => {
    await db.exec(
      "INSERT INTO team_works (instance_id, number, repo, branch, base_branch, base_sha) SELECT id, 1, 'o/r', 'botcave/lavoro-1-1', 'main', 'a' FROM team_instances",
    );
    const w = await db.query<any>("SELECT status, post_scripts FROM team_works");
    expect(w.rows).toEqual([{ status: "open", post_scripts: [] }]);
    await expect(
      db.exec(
        "INSERT INTO team_works (instance_id, number, status, repo, branch, base_branch, base_sha) SELECT id, 2, 'awaiting_release', 'o/r', 'b', 'main', 'a' FROM team_instances",
      ),
    ).rejects.toThrow();
    await db.exec("UPDATE team_works SET status = 'released'");
    await db.exec(
      "INSERT INTO team_works (instance_id, number, repo, branch, base_branch, base_sha) SELECT id, 2, 'o/r', 'botcave/lavoro-1-2', 'main', 'a' FROM team_instances",
    );
    await expect(
      db.exec(
        "INSERT INTO team_works (instance_id, number, status, repo, branch, base_branch, base_sha) SELECT id, 2, 'released', 'o/r', 'b', 'main', 'a' FROM team_instances",
      ),
    ).rejects.toThrow();
  });

  it("work_id dei compiti si azzera eliminando il lavoro, i lavori spariscono con la squadra", async () => {
    await db.exec("UPDATE team_code_tasks SET work_id = (SELECT max(id) FROM team_works)");
    await db.exec("DELETE FROM team_works WHERE number = 2");
    const c = await db.query<any>("SELECT work_id FROM team_code_tasks");
    expect(c.rows).toEqual([{ work_id: null }]);
    await db.exec("DELETE FROM team_code_tasks");
    await db.exec("DELETE FROM team_instances");
    const w = await db.query<any>("SELECT count(*)::int AS n FROM team_works");
    expect(w.rows).toEqual([{ n: 0 }]);
  });

  it("valori nuovi degli enum", async () => {
    const k = await db.query<any>("SELECT unnest(enum_range(NULL::pending_action_kind))::text AS v");
    expect(k.rows.map((r: any) => r.v)).toContain("release");
    const e = await db.query<any>("SELECT unnest(enum_range(NULL::team_event_type))::text AS v");
    expect(e.rows.map((r: any) => r.v)).toContain("lavoro_in_prova");
  });
});

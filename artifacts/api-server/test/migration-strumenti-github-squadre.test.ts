import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const COLUMNS = [
  "base_branch",
  "branch",
  "ci_checked_at",
  "ci_notified_sha",
  "ci_pending_notified",
  "ci_state",
  "ci_summary",
  "created_at",
  "head_sha",
  "id",
  "instance_id",
  "last_commit_at",
  "plan_task_id",
  "pr_number",
  "pr_state",
  "pr_url",
  "repo",
  "updated_at",
];

describe("migrazione 2026-11-strumenti-github-squadre", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema precedente (dopo il nodo locale) con una squadra; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com');
      INSERT INTO team_instances (name, ref_app_id, ref_type, ref_id, ref_title)
        SELECT 'Squadra', id, 'wi', '1', 'wi 1' FROM apps;
    `);
    await db.exec(read("../../../docs/migrations/2026-11-strumenti-github-squadre.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-strumenti-github-squadre.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("crea team_code_tasks con le colonne della spec", async () => {
    const cols = await db.query<any>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'team_code_tasks' ORDER BY column_name",
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(COLUMNS);
    const enums = await db.query<any>(
      "SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname IN ('code_pr_state','code_ci_state') GROUP BY t.typname ORDER BY t.typname",
    );
    expect(enums.rows).toEqual([
      { typname: "code_ci_state", labels: ["pending", "success", "failure", "none"] },
      { typname: "code_pr_state", labels: ["open", "merged", "closed"] },
    ]);
  });

  it("(instance_id, plan_task_id) è unico, ci_pending_notified parte falso e l'eliminazione della squadra cancella la riga", async () => {
    const ins = (task: string) =>
      db.exec(`INSERT INTO team_code_tasks (instance_id, plan_task_id, repo, branch, base_branch)
               SELECT id, '${task}', 'o/r', 'botcave/t1', 'main' FROM team_instances`);
    await ins("t1");
    await expect(ins("t1")).rejects.toThrow();
    await ins("t2");
    const r = await db.query<any>("SELECT ci_pending_notified, pr_state, ci_state FROM team_code_tasks");
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual({ ci_pending_notified: false, pr_state: null, ci_state: null });
    await db.exec("DELETE FROM team_instances");
    expect((await db.query<any>("SELECT 1 FROM team_code_tasks")).rows).toHaveLength(0);
  });

  it("ha l'indice di sorveglianza e schema-casello.sql contiene le stesse definizioni", async () => {
    const idx = await db.query<any>("SELECT 1 FROM pg_indexes WHERE indexname = 'team_code_tasks_watch_idx'");
    expect(idx.rows).toHaveLength(1);
    const schema = read("../../../docs/schema-casello.sql");
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS "team_code_tasks"');
    expect(schema).toContain("code_pr_state");
    expect(schema).toContain("code_ci_state");
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS "team_code_tasks_watch_idx"');
  });
});

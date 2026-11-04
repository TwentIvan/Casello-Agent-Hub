import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-11-squadre-esecuzione.sql";

const TABLES = ["team_plans", "team_plan_versions", "team_tasks", "team_task_steps", "team_turns", "team_turn_steps", "team_events"];
const ENUMS = ["team_plan_status", "team_task_status", "team_turn_status", "team_event_type", "pending_action_kind"];

describe("migrazione 2026-11-squadre-esecuzione", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente con righe già presenti; lo script si applica due volte (idempotenza)
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-squadre-esecuzione.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('a@example.com');
      INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com');
      INSERT INTO app_tools (app_id, name, description, kind, status, definition)
        SELECT id, 'tool', 'd', 'http', 'active', '{}'::jsonb FROM apps;
      INSERT INTO pending_actions (user_id, number, app_id, tool_id, args_enc, args_public, recipient, summary)
        SELECT u.id, 1, a.id, t.id, 'x', '{}'::jsonb, 'r', 's' FROM users u, apps a, app_tools t;
      INSERT INTO team_instances (name, ref_app_id, ref_type, ref_id, ref_title)
        SELECT 'Squadra', id, 'wi', '1', 'Titolo' FROM apps;
    `);
    await db.exec(read(SQL));
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  it("crea le sette tabelle e i cinque enum", async () => {
    const t = await db.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
      [TABLES],
    );
    expect(t.rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort());
    const e = await db.query<any>("SELECT typname FROM pg_type WHERE typname = ANY($1)", [ENUMS]);
    expect(e.rows.map((r) => r.typname).sort()).toEqual([...ENUMS].sort());
  });

  it("le azioni già in coda diventano kind = action", async () => {
    const r = await db.query<any>("SELECT kind, team_instance_id, plan_version FROM pending_actions");
    expect(r.rows).toEqual([{ kind: "action", team_instance_id: null, plan_version: null }]);
  });

  it("il CHECK rifiuta un'azione senza tool, ammette una voce plan", async () => {
    const ins = (kind: string) => `INSERT INTO pending_actions (user_id, number, kind, args_enc, args_public, recipient, summary)
      SELECT id, 2, '${kind}', 'x', '{}'::jsonb, 'r', 's' FROM users`;
    await expect(db.exec(ins("action"))).rejects.toThrow(/check/i);
    await db.exec(ins("plan"));
    const r = await db.query<any>("SELECT tool_id, app_id FROM pending_actions WHERE kind = 'plan'");
    expect(r.rows).toEqual([{ tool_id: null, app_id: null }]);
  });

  it("al più un turno queued e uno running per istanza", async () => {
    const ins = (s: string) => `INSERT INTO team_turns (instance_id, status) SELECT id, '${s}' FROM team_instances`;
    await db.exec(ins("queued"));
    await expect(db.exec(ins("queued"))).rejects.toThrow(/unique|duplicate/i);
    await db.exec(ins("running"));
    await expect(db.exec(ins("running"))).rejects.toThrow(/unique|duplicate/i);
    await db.exec(ins("done"));
    await db.exec(ins("done"));
  });

  it("PLAN unico per istanza, versioni uniche, passi che seguono compito e turno", async () => {
    await db.exec(`INSERT INTO team_plans (instance_id) SELECT id FROM team_instances`);
    await expect(db.exec(`INSERT INTO team_plans (instance_id) SELECT id FROM team_instances`)).rejects.toThrow(/unique|duplicate/i);
    expect((await db.query<any>("SELECT status, version FROM team_plans")).rows).toEqual([{ status: "draft", version: 1 }]);
    const v = `INSERT INTO team_plan_versions (instance_id, version, plan) SELECT id, 1, '{}'::jsonb FROM team_instances`;
    await db.exec(v);
    await expect(db.exec(v)).rejects.toThrow(/unique|duplicate/i);

    await db.exec(`INSERT INTO team_tasks (instance_id, plan_task_id, role_key, instructions) SELECT id, 't1', 'dev', 'fai' FROM team_instances`);
    await db.exec(`INSERT INTO team_task_steps (task_id, position, type) SELECT id, 1, 'model' FROM team_tasks`);
    await db.exec(`INSERT INTO team_turn_steps (turn_id, position, type) SELECT id, 1, 'model' FROM team_turns`);
    await db.exec(`INSERT INTO team_events (instance_id, type, task_id, bulletin) SELECT instance_id, 'compito_finito', id, 'ok' FROM team_tasks`);
    await db.exec("DELETE FROM team_tasks");
    expect((await db.query<any>("SELECT 1 FROM team_task_steps")).rows).toHaveLength(0);
    expect((await db.query<any>("SELECT task_id FROM team_events")).rows).toEqual([{ task_id: null }]);
    await db.exec("DELETE FROM team_turns");
    expect((await db.query<any>("SELECT 1 FROM team_turn_steps")).rows).toHaveLength(0);
  });
});

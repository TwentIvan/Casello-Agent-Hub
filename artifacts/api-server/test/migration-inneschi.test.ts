import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const migration = (name: string) => read(`../../../docs/migrations/${name}.sql`);

describe("migrazione 2026-11-inneschi", () => {
  let db: PGlite;
  let agentId: number;
  let toolId: number;

  const insertTrigger = (cols: string, vals: string, params: unknown[] = []) =>
    db.query<any>(`INSERT INTO agent_triggers (agent_id, ${cols}) VALUES (${agentId}, ${vals}) RETURNING id`, params);
  const poll = (name: string, extraCols = "", extraVals = "") =>
    insertTrigger(
      `kind, name, tool_id, interval_seconds, next_poll_at${extraCols}`,
      `'poll', '${name}', ${toolId}, 300, now()${extraVals}`,
    );

  beforeAll(async () => {
    // Schema di produzione prima degli inneschi, con app, agente, tool e run già presenti; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    for (const m of [
      "2026-11-nodo-locale",
      "2026-11-nodo-cartelle",
      "2026-11-connettore-oauth",
      "2026-11-alfred",
      "2026-11-lucius-squadra",
      "2026-11-personaggi",
      "2026-11-plugin-incorporabile",
      "2026-11-thu-5c-tappa1",
    ]) {
      await db.exec(migration(m));
    }
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com');
      INSERT INTO agents (app_id, name, role) SELECT id, 'Agente', 'general' FROM apps;
      INSERT INTO app_tools (app_id, name, kind, definition) SELECT id, 'elenca', 'http', '{}'::jsonb FROM apps;
      INSERT INTO runs (agent_id) SELECT id FROM agents;
    `);
    agentId = (await db.query<any>("SELECT id FROM agents")).rows[0].id;
    toolId = (await db.query<any>("SELECT id FROM app_tools")).rows[0].id;
    await db.exec(migration("2026-11-inneschi"));
    await db.exec(migration("2026-11-inneschi"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("tabelle e colonne", async () => {
    const t = await db.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('agent_triggers', 'trigger_seen_items') ORDER BY table_name",
    );
    expect(t.rows.map((x) => x.table_name)).toEqual(["agent_triggers", "trigger_seen_items"]);
    const c = await db.query<any>(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'trigger_id'",
    );
    expect(c.rows).toEqual([{ data_type: "integer", is_nullable: "YES" }]);
  });

  it("default", async () => {
    const r = await db.query<any>(
      `INSERT INTO agent_triggers (agent_id, kind, name, secret_hash) VALUES (${agentId}, 'webhook', 'default', 'h')
       RETURNING status, baseline_done, consecutive_errors, runs_created, interval_seconds, args`,
    );
    expect(r.rows[0]).toMatchObject({ status: "paused", baseline_done: false, consecutive_errors: 0, runs_created: 0, args: {} });
  });

  it("CHECK poll, webhook e cursore", async () => {
    await expect(insertTrigger("kind, name", "'poll', 'senza-tool'")).rejects.toThrow(/agent_triggers_poll_check/);
    await expect(insertTrigger("kind, name", "'webhook', 'senza-segreto'")).rejects.toThrow(/agent_triggers_webhook_check/);
    await expect(poll("senza-campo", ", cursor_param", ", 'since'")).rejects.toThrow(/agent_triggers_cursor_check/);
    await poll("con-cursore", ", cursor_param, cursor_field", ", 'since', 'createdAt'");
  });

  it("nome unico per agente", async () => {
    await poll("doppione");
    await expect(poll("doppione")).rejects.toThrow(/agent_triggers_agent_name_key/);
  });

  it("seen unico", async () => {
    const t = await poll("per-seen");
    const id = t.rows[0].id;
    await db.query("INSERT INTO trigger_seen_items (trigger_id, item_key) VALUES ($1, 'a')", [id]);
    await expect(db.query("INSERT INTO trigger_seen_items (trigger_id, item_key) VALUES ($1, 'a')", [id])).rejects.toThrow(
      /duplicate key/,
    );
  });

  it("eliminare l'innesco lascia la run con trigger_id null; eliminare l'agente elimina inneschi e chiavi", async () => {
    const t = await poll("per-run");
    const id = t.rows[0].id;
    const run = await db.query<any>("INSERT INTO runs (agent_id, trigger_id) VALUES ($1, $2) RETURNING id", [agentId, id]);
    await db.query("DELETE FROM agent_triggers WHERE id = $1", [id]);
    const r = await db.query<any>("SELECT trigger_id FROM runs WHERE id = $1", [run.rows[0].id]);
    expect(r.rows).toEqual([{ trigger_id: null }]);

    const a = await db.query<any>("INSERT INTO agents (app_id, name, role) SELECT app_id, 'Altro', 'area' FROM agents LIMIT 1 RETURNING id");
    const t2 = await db.query<any>(
      `INSERT INTO agent_triggers (agent_id, kind, name, secret_hash) VALUES ($1, 'webhook', 'x', 'h') RETURNING id`,
      [a.rows[0].id],
    );
    await db.query("INSERT INTO trigger_seen_items (trigger_id, item_key) VALUES ($1, 'k')", [t2.rows[0].id]);
    await db.query("DELETE FROM agents WHERE id = $1", [a.rows[0].id]);
    expect((await db.query<any>("SELECT 1 FROM agent_triggers WHERE id = $1", [t2.rows[0].id])).rows).toEqual([]);
    expect((await db.query<any>("SELECT 1 FROM trigger_seen_items WHERE trigger_id = $1", [t2.rows[0].id])).rows).toEqual([]);
  });

  it("eliminare il tool usato da un innesco poll fallisce", async () => {
    await expect(db.query("DELETE FROM app_tools WHERE id = $1", [toolId])).rejects.toThrow(/foreign key/);
  });

  it("character_proposals accetta agent_trigger_create", async () => {
    const check = await db.query<any>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'character_proposals_kind_check'",
    );
    expect(check.rows[0].def).toContain("agent_trigger_create");
    expect(check.rows[0].def).toContain("handoff");
  });

  it("schema-casello.sql contiene le stesse parti", () => {
    const s = read("../../../docs/schema-casello.sql");
    for (const part of ["agent_triggers", "trigger_seen_items", '"trigger_id" integer', "agent_trigger_create", "agent_triggers_poll_check"]) {
      expect(s).toContain(part);
    }
  });
});

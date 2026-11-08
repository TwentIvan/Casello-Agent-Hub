import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const migration = (name: string) => read(`../../../docs/migrations/${name}.sql`);

describe("migrazione 2026-11-proposte-multiple", () => {
  let db: PGlite;
  let actionId: number;
  let toolId: number;

  beforeAll(async () => {
    // Schema di produzione prima delle proposte multiple, con app, tool, utente e voce in coda; lo script si applica due volte
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
      "2026-11-inneschi",
    ]) {
      await db.exec(migration(m));
    }
    await db.exec(migration("2026-11-proposte-multiple"));
    await db.exec(migration("2026-11-proposte-multiple"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('u@example.com');
      INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com');
      INSERT INTO app_tools (app_id, name, kind, definition) SELECT id, 'crea', 'http', '{}'::jsonb FROM apps;
    `);
    toolId = (await db.query<any>("SELECT id FROM app_tools")).rows[0].id;
    actionId = (
      await db.query<any>(
        `INSERT INTO pending_actions (user_id, number, kind, app_id, args_enc, args_public, recipient, summary)
         SELECT u.id, 1, 'proposal', a.id, 'x', '{}'::jsonb, 'App', 'Titolo' FROM users u, apps a RETURNING id`,
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await db.close();
  });

  it("il tipo pending_action_kind termina con proposal", async () => {
    const r = await db.query<any>("SELECT enum_range(NULL::pending_action_kind)::text AS r");
    expect(r.rows[0].r).toBe("{action,plan,plan_change,proposal}");
  });

  it("esiste pending_action_steps con i sei stati", async () => {
    const t = await db.query<any>("SELECT 1 FROM information_schema.tables WHERE table_name = 'pending_action_steps'");
    expect(t.rows).toHaveLength(1);
    const s = await db.query<any>("SELECT enum_range(NULL::pending_action_step_status)::text AS r");
    expect(s.rows[0].r).toBe("{pending,excluded,skipped,done,failed,not_run}");
  });

  const insertStep = (key: string, position: number) =>
    db.query(
      "INSERT INTO pending_action_steps (pending_action_id, key, position, tool_id, summary) VALUES ($1, $2, $3, $4, 'Passo')",
      [actionId, key, position, toolId],
    );

  it("chiave unica per voce e stato predefinito pending", async () => {
    await insertStep("p1", 1);
    await expect(insertStep("p1", 2)).rejects.toThrow(/pending_action_steps_action_key_unique/);
    const r = await db.query<any>("SELECT status FROM pending_action_steps WHERE key = 'p1'");
    expect(r.rows).toEqual([{ status: "pending" }]);
  });

  it("eliminare un tool usato da un passo fallisce", async () => {
    await expect(db.query("DELETE FROM app_tools WHERE id = $1", [toolId])).rejects.toThrow(/foreign key/);
  });

  it("eliminare la voce elimina i passi", async () => {
    await db.query("DELETE FROM pending_actions WHERE id = $1", [actionId]);
    const r = await db.query<any>("SELECT 1 FROM pending_action_steps WHERE pending_action_id = $1", [actionId]);
    expect(r.rows).toEqual([]);
  });

  it("alfred_confirmations.exclude_steps è jsonb nullable", async () => {
    const c = await db.query<any>(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'alfred_confirmations' AND column_name = 'exclude_steps'",
    );
    expect(c.rows).toEqual([{ data_type: "jsonb", is_nullable: "YES" }]);
  });

  it("schema-casello.sql contiene le stesse parti", () => {
    const s = read("../../../docs/schema-casello.sql");
    for (const part of ["pending_action_steps", "pending_action_step_status", "'plan_change', 'proposal'", '"exclude_steps" jsonb']) {
      expect(s).toContain(part);
    }
  });
});

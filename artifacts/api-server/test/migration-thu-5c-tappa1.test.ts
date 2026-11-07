import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-thu-5c-tappa1", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema di produzione prima di 5c, con un'app, un agente e una run già presenti; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-cartelle.sql"));
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com');
      INSERT INTO agents (app_id, name, role) SELECT id, 'Agente', 'general' FROM apps;
      INSERT INTO runs (agent_id) SELECT id FROM agents;
    `);
    await db.exec(read("../../../docs/migrations/2026-11-thu-5c-tappa1.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-thu-5c-tappa1.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("le run esistenti hanno has_user_token false e nessuna run madre", async () => {
    const r = await db.query<any>("SELECT has_user_token, parent_run_id FROM runs");
    expect(r.rows).toEqual([{ has_user_token: false, parent_run_id: null }]);
  });

  it("gli agenti esistenti hanno confirm_writes false", async () => {
    const r = await db.query<any>("SELECT confirm_writes FROM agents");
    expect(r.rows).toEqual([{ confirm_writes: false }]);
  });

  it("colonne e tipi", async () => {
    const r = await db.query<any>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE (table_name = 'runs' AND column_name IN ('parent_run_id', 'has_user_token'))
          OR (table_name = 'agents' AND column_name = 'confirm_writes') ORDER BY table_name, column_name`,
    );
    expect(r.rows).toEqual([
      { table_name: "agents", column_name: "confirm_writes", data_type: "boolean", is_nullable: "NO", column_default: "false" },
      { table_name: "runs", column_name: "has_user_token", data_type: "boolean", is_nullable: "NO", column_default: "false" },
      { table_name: "runs", column_name: "parent_run_id", data_type: "integer", is_nullable: "YES", column_default: null },
    ]);
  });

  it("indici creati", async () => {
    const r = await db.query<any>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'runs' AND indexname IN ('runs_agent_status_idx', 'runs_parent_run_id_idx') ORDER BY indexname",
    );
    expect(r.rows.map((x) => x.indexname)).toEqual(["runs_agent_status_idx", "runs_parent_run_id_idx"]);
  });

  it("eliminando la run madre la figlia resta con parent_run_id null", async () => {
    const m = await db.query<any>("INSERT INTO runs (agent_id) SELECT agent_id FROM runs LIMIT 1 RETURNING id");
    const parent = m.rows[0].id;
    const c = await db.query<any>(
      "INSERT INTO runs (agent_id, parent_run_id) SELECT agent_id, $1 FROM runs LIMIT 1 RETURNING id",
      [parent],
    );
    await db.query("DELETE FROM runs WHERE id = $1", [parent]);
    const r = await db.query<any>("SELECT parent_run_id FROM runs WHERE id = $1", [c.rows[0].id]);
    expect(r.rows).toEqual([{ parent_run_id: null }]);
  });

  it("schema-casello.sql contiene le stesse colonne", () => {
    const s = read("../../../docs/schema-casello.sql");
    expect(s).toContain('"parent_run_id" integer');
    expect(s).toContain('"has_user_token" boolean DEFAULT false NOT NULL');
    expect(s).toContain('"confirm_writes" boolean DEFAULT false NOT NULL');
  });
});

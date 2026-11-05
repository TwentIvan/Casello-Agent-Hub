import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-11-nodo-locale.sql";

describe("migrazione 2026-11-nodo-locale", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente con righe già presenti; lo script si applica due volte (idempotenza)
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('a@example.com');
      INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com');
      INSERT INTO team_instances (name, ref_app_id, ref_type, ref_id, ref_title)
        SELECT 'Squadra', id, 'wi', '1', 'Titolo' FROM apps;
      INSERT INTO team_tasks (instance_id, plan_task_id, role_key, instructions)
        SELECT id, 't1', 'dev', 'fai' FROM team_instances;
      INSERT INTO api_tokens (user_id, token_hash, name, expires_at)
        SELECT id, 'h0', 'vecchio', now() + interval '1 day' FROM users;
    `);
    await db.exec(read(SQL));
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  it("crea le tabelle, l'enum e le colonne nuove", async () => {
    const t = await db.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('nodes', 'team_attachments')",
    );
    expect(t.rows.map((r) => r.table_name).sort()).toEqual(["nodes", "team_attachments"]);
    expect((await db.query<any>("SELECT 1 FROM pg_type WHERE typname = 'node_status'")).rows).toHaveLength(1);
    const c = await db.query<any>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND (
         (table_name = 'api_tokens' AND column_name = 'node_id') OR
         (table_name = 'team_instances' AND column_name = 'node_workspace') OR
         (table_name = 'team_tasks' AND column_name IN ('node_id','lease_token','lease_expires_at','session_id','waiting_since','no_node_notified','attachment_ids')))`,
    );
    expect(c.rows).toHaveLength(9);
  });

  it("le righe esistenti di team_tasks hanno attachment_ids vuoto e no_node_notified falso", async () => {
    const r = await db.query<any>("SELECT attachment_ids, no_node_notified, node_id FROM team_tasks");
    expect(r.rows).toEqual([{ attachment_ids: [], no_node_notified: false, node_id: null }]);
    expect((await db.query<any>("SELECT node_id FROM api_tokens")).rows).toEqual([{ node_id: null }]);
  });

  it("nome del nodo unico per utente, stato predefinito active", async () => {
    const ins = "INSERT INTO nodes (user_id, name) SELECT id, 'mac' FROM users";
    await db.exec(ins);
    await expect(db.exec(ins)).rejects.toThrow(/unique|duplicate/i);
    const r = await db.query<any>("SELECT status, skills, max_concurrent FROM nodes");
    expect(r.rows).toEqual([{ status: "active", skills: [], max_concurrent: 1 }]);
  });

  it("eliminare un nodo elimina il suo token e libera i compiti (SET NULL)", async () => {
    await db.exec(`INSERT INTO api_tokens (user_id, token_hash, name, expires_at, node_id)
      SELECT u.id, 'h1', 'nodo', now() + interval '1 day', n.id FROM users u, nodes n`);
    await db.exec("UPDATE team_tasks SET node_id = (SELECT id FROM nodes)");
    await db.exec("DELETE FROM nodes");
    expect((await db.query<any>("SELECT name FROM api_tokens")).rows).toEqual([{ name: "vecchio" }]);
    expect((await db.query<any>("SELECT node_id FROM team_tasks")).rows).toEqual([{ node_id: null }]);
  });

  it("gli allegati seguono l'istanza (cascade) e conservano i byte", async () => {
    await db.exec(`INSERT INTO team_attachments (instance_id, name, content_type, size_bytes, sha256, content)
      SELECT id, 'a.txt', 'text/plain', 3, 'abc', '\\x616263'::bytea FROM team_instances`);
    const r = await db.query<any>("SELECT encode(content, 'escape') AS c, deleted_at FROM team_attachments");
    expect(r.rows).toEqual([{ c: "abc", deleted_at: null }]);
    await db.exec("DELETE FROM team_instances");
    expect((await db.query<any>("SELECT 1 FROM team_attachments")).rows).toHaveLength(0);
  });
});

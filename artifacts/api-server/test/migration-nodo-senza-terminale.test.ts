import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const NEW_COLUMNS = [
  "claude_checked_at",
  "claude_status",
  "diagnostics_requested_at",
  "kind",
  "paired_at",
  "paired_ip",
  "settings",
  "uninstall_requested_at",
  "update_failed_version",
];

describe("migrazione 2026-11-nodo-senza-terminale", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema dopo il nodo locale e le cartelle, con un nodo già registrato; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-cartelle.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('a@example.com');
      INSERT INTO nodes (user_id, name) SELECT id, 'mac' FROM users;
    `);
    await db.exec(read("../../../docs/migrations/2026-11-nodo-senza-terminale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-senza-terminale.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("aggiunge le nove colonne a nodes, tutte nullable e null sui nodi esistenti", async () => {
    const cols = await db.query<any>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'nodes' AND column_name = ANY($1) ORDER BY column_name",
      [NEW_COLUMNS],
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(NEW_COLUMNS);
    expect(cols.rows.every((r) => r.is_nullable === "YES")).toBe(true);
    const r = await db.query<any>(`SELECT ${NEW_COLUMNS.join(", ")} FROM nodes`);
    expect(Object.values(r.rows[0]).every((v) => v === null)).toBe(true);
  });

  it("node_pairings ha user_code_hash unico e si cancella con il nodo e l'utente", async () => {
    const ins = (code: string) =>
      db.exec(`INSERT INTO node_pairings (user_code_hash, poll_secret_hash, device_name, version, expires_at)
               VALUES ('${code}', 'p', 'Mac', '0.3.0', now() + interval '10 minutes')`);
    await ins("h1");
    await expect(ins("h1")).rejects.toThrow();
    const r = await db.query<any>("SELECT status, failed_attempts, id FROM node_pairings");
    expect(r.rows[0].status).toBe("pending");
    expect(r.rows[0].failed_attempts).toBe(0);
    expect(r.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    await db.exec(`UPDATE node_pairings SET node_id = (SELECT id FROM nodes LIMIT 1), user_id = (SELECT id FROM users LIMIT 1)`);
    await db.exec("DELETE FROM nodes");
    expect((await db.query<any>("SELECT 1 FROM node_pairings")).rows).toHaveLength(0);
  });

  it("node_diagnostics.node_id è la chiave primaria con ON DELETE CASCADE", async () => {
    const pk = await db.query<any>(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'node_diagnostics'::regclass AND i.indisprimary`,
    );
    expect(pk.rows).toEqual([{ attname: "node_id" }]);
    await db.exec(`INSERT INTO nodes (user_id, name) SELECT id, 'mac2' FROM users`);
    await db.exec(`INSERT INTO node_diagnostics (node_id, content) SELECT id, 'log' FROM nodes`);
    await db.exec("DELETE FROM nodes");
    expect((await db.query<any>("SELECT 1 FROM node_diagnostics")).rows).toHaveLength(0);
  });

  it("schema-casello.sql contiene le stesse definizioni", () => {
    const schema = read("../../../docs/schema-casello.sql");
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS "node_pairings"');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS "node_diagnostics"');
    for (const c of NEW_COLUMNS) expect(schema).toContain(`ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "${c}"`);
  });
});

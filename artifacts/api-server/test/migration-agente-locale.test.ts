import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-agente-locale.sql";

// psql esegue ogni istruzione in autocommit; PGlite.exec le raggruppa. Il valore dell'enum si aggiunge prima di
// BEGIN, quindi si esegue in due tempi (prima di BEGIN e dopo) per non usare un valore non ancora confermato.
const runMigration = async (db: PGlite) => {
  const [before, after] = read(SQL).split(/^BEGIN;$/m);
  await db.exec(before);
  await db.exec("BEGIN;" + after);
};

describe("migrazione 2026-10-agente-locale", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-agente-locale.sql"));
    await db.exec(`INSERT INTO users (email) VALUES ('ivan@example.com');`);
    await db.exec(`INSERT INTO apps (name, slug, base_url) VALUES ('A', 'a', 'https://a.example.com');`);
    await db.exec(`INSERT INTO agents (app_id, name) VALUES (1, 'Esistente');`);
    await runMigration(db);
  });

  afterAll(async () => {
    await db.close();
  });

  const columns = async (table: string) =>
    (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table])).rows.map(
      (r) => r.column_name,
    );

  it("crea le tabelle con le colonne attese", async () => {
    expect(await columns("local_machines")).toEqual(
      expect.arrayContaining(["id", "user_id", "name", "token_hash", "last_seen_at", "revoked_at", "created_at"]),
    );
    expect(await columns("mcp_tokens")).toEqual(
      expect.arrayContaining(["id", "user_id", "name", "token_hash", "last_used_at", "revoked_at", "created_at"]),
    );
    expect(await columns("local_jobs")).toEqual(
      expect.arrayContaining([
        "id", "user_id", "machine_id", "kind", "analysis_id", "run_id", "status", "origin", "fallback_ai_model_id",
        "claude_session_id", "claimed_by", "current_item", "job_token_hash", "job_token_expires_at", "heartbeat_at",
        "error", "created_at", "updated_at",
      ]),
    );
  });

  it("aggiunge le colonne a agents e analyses, con i default per le righe esistenti", async () => {
    expect(await columns("analyses")).toContain("fallback_ai_model_id");
    const row = (await db.query<any>("SELECT * FROM agents")).rows[0];
    expect(row).toMatchObject({
      fallback_ai_model_id: null,
      local_offline_policy: "fallback",
      local_offline_wait_s: 30,
      local_for_third_parties: false,
    });
  });

  it("il provider local_agent è presente, gestito e dal registro", async () => {
    const row = (await db.query<any>("SELECT * FROM providers WHERE slug = 'local_agent'")).rows[0];
    expect(row).toMatchObject({
      name: "Agente locale",
      protocol: "local_agent",
      default_base_url: null,
      source_keys: { litellm: [], openrouterAuthor: null },
      status: "managed",
      origin: "registry",
    });
  });

  it("è idempotente", async () => {
    await runMigration(db);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM providers WHERE slug = 'local_agent'")).rows[0].n).toBe(1);
  });

  it("un lavoro con una macchina inesistente è rifiutato (FK)", async () => {
    await expect(
      db.exec(`INSERT INTO local_jobs (user_id, machine_id, kind, origin) VALUES (1, 999, 'run', 'console')`),
    ).rejects.toThrow(/local_jobs_machine_id_local_machines_id_fk/);
  });

  it("lavoro di prova: default, token unico dove non nullo, cascata dalla macchina", async () => {
    await db.exec(`INSERT INTO local_machines (user_id, name, token_hash) VALUES (1, 'Mac', 'h1')`);
    await db.exec(`INSERT INTO local_jobs (user_id, machine_id, kind, origin) VALUES (1, 1, 'analysis', 'console'), (1, 1, 'run', 'app')`);
    const rows = (await db.query<any>("SELECT status, claimed_by, job_token_hash FROM local_jobs")).rows;
    expect(rows).toEqual([
      { status: "queued", claimed_by: null, job_token_hash: null },
      { status: "queued", claimed_by: null, job_token_hash: null },
    ]);
    await db.exec(`UPDATE local_jobs SET job_token_hash = 'x' WHERE kind = 'analysis'`);
    await expect(db.exec(`UPDATE local_jobs SET job_token_hash = 'x' WHERE kind = 'run'`)).rejects.toThrow(/local_jobs_job_token_hash_unique/);
    await expect(db.exec(`INSERT INTO local_machines (user_id, name, token_hash) VALUES (1, 'Altro', 'h1')`)).rejects.toThrow(/unique/);
    await db.exec(`DELETE FROM local_machines`);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM local_jobs")).rows[0].n).toBe(0);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-esecutore-locale.sql";

describe("migrazione 2026-10-esecutore-locale", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente, con un'analisi esistente
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-esecutore-locale.sql"));
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('Mister', 'mister', 'http://a');
      INSERT INTO analyses (app_id, model, sources, max_tokens, tokens_used)
        SELECT id, 'm', '{"code": "none", "openapi": false, "description": false}', 1000, 100 FROM apps;
      INSERT INTO users (email) VALUES ('ivan@example.com');
    `);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  it("l'analisi esistente è cloud, con lease e commit nulli, il resto intatto", async () => {
    expect(
      (await db.query<any>("SELECT executor, lease_token_hash, lease_until, lease_label, source_commit, tokens_used FROM analyses")).rows,
    ).toEqual([
      { executor: "cloud", lease_token_hash: null, lease_until: null, lease_label: null, source_commit: null, tokens_used: 100 },
    ]);
  });

  it("le tabelle nuove accettano una riga", async () => {
    await db.exec(`
      INSERT INTO analysis_phase_results (analysis_id, phase, result) SELECT id, 'tool', '{"items": []}' FROM analyses;
      INSERT INTO api_tokens (user_id, token_hash, name, expires_at) SELECT id, 'abc', 'Mac', now() + interval '30 days' FROM users;
    `);
    expect((await db.query<any>("SELECT phase, submitted_at IS NOT NULL AS has_at FROM analysis_phase_results")).rows).toEqual([
      { phase: "tool", has_at: true },
    ]);
    expect((await db.query<any>("SELECT name, last_used_at, revoked_at FROM api_tokens")).rows).toEqual([
      { name: "Mac", last_used_at: null, revoked_at: null },
    ]);
  });

  it("rifiuta un esito duplicato per (analisi, fase) e un token_hash duplicato", async () => {
    await expect(
      db.exec(`INSERT INTO analysis_phase_results (analysis_id, phase, result) SELECT id, 'tool', '{}' FROM analyses`),
    ).rejects.toThrow(/analysis_phase_results_unique/);
    await expect(
      db.exec(`INSERT INTO api_tokens (user_id, token_hash, name, expires_at) SELECT id, 'abc', 'Altro', now() FROM users`),
    ).rejects.toThrow(/duplicate key/);
  });

  it("eliminando l'analisi o l'utente le righe collegate spariscono", async () => {
    await db.exec(`DELETE FROM analyses; DELETE FROM users;`);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM analysis_phase_results")).rows[0].n).toBe(0);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM api_tokens")).rows[0].n).toBe(0);
  });

  it("è idempotente", async () => {
    await db.exec(read(SQL));
    await db.exec(read(SQL));
    expect((await db.query<any>("SELECT count(*)::int AS n FROM pg_type WHERE typname = 'analysis_executor'")).rows[0].n).toBe(1);
  });
});

// Esecutore delle migrazioni all'avvio dell'API: registro `schema_migrations`, lock di sessione,
// istruzioni una alla volta in autocommit (come `psql -f` con ON_ERROR_STOP). Vedi la spec delle migrazioni automatiche.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import type { Logger } from "pino";
import { BASELINE_MIGRATIONS } from "./baseline.js";
import { classifyMigration, isPostMigration } from "./classify.js";
import { splitSql } from "./split.js";

/** Chiave fissa del lock di sessione (bigint costante, hash di "botcave:schema_migrations"). */
export const MIGRATION_LOCK_KEY = 7243065828119433191n;

/** Errore di una migrazione: solo nome del file e numero dell'istruzione, mai il testo SQL. */
export class MigrationError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly statement: number,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

export interface RunMigrationsOptions {
  pool: pg.Pool;
  dir: string;
  logger: Pick<Logger, "info" | "warn">;
  baseline?: readonly string[];
}

export async function runMigrations(opts: RunMigrationsOptions): Promise<{ baselined: number; applied: string[] }> {
  const { pool, dir, logger } = opts;
  const baseline = opts.baseline ?? BASELINE_MIGRATIONS;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !isPostMigration(f))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const contents = new Map(
    files.map((f) => [f, readFileSync(join(dir, f), "utf8").replace(/\r\n?/g, "\n")] as const),
  );
  const shaOf = (f: string) => createHash("sha256").update(contents.get(f)!).digest("hex");

  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SET statement_timeout = 0");
    await client.query("SET lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY.toString()]);
    locked = true;

    await client.query(
      `CREATE TABLE IF NOT EXISTS "schema_migrations" (
        "name" text PRIMARY KEY,
        "sha256" text NOT NULL,
        "baseline" boolean NOT NULL DEFAULT false,
        "applied_at" timestamp with time zone NOT NULL DEFAULT now()
      )`,
    );

    const existing = await client.query<{ name: string; sha256: string }>("SELECT name, sha256 FROM schema_migrations");
    const known = new Map(existing.rows.map((r) => [r.name, r.sha256]));

    let baselined = 0;
    if (known.size === 0) {
      for (const name of baseline) {
        if (!contents.has(name)) continue;
        const sum = shaOf(name);
        await client.query(
          "INSERT INTO schema_migrations (name, sha256, baseline) VALUES ($1, $2, true) ON CONFLICT (name) DO NOTHING",
          [name, sum],
        );
        known.set(name, sum);
        baselined++;
      }
      if (baselined > 0) logger.info({ count: baselined }, "Migrazioni esistenti registrate senza eseguirle");
    }

    const applied: string[] = [];
    for (const name of files) {
      const sum = shaOf(name);
      const registeredSha = known.get(name);
      if (registeredSha !== undefined) {
        if (registeredSha !== sum) {
          logger.warn({ name, sha: sum.slice(0, 7), registeredSha: registeredSha.slice(0, 7) }, "Migrazione già applicata ma modificata: non rieseguita");
        }
        continue;
      }
      const sql = contents.get(name)!;
      if (classifyMigration(name, sql).destructive) {
        throw new MigrationError(`migrazione distruttiva fuori da un file -post: ${name}`, name, 0);
      }
      const started = Date.now();
      const statements = splitSql(sql);
      for (let i = 0; i < statements.length; i++) {
        try {
          await client.query(statements[i]!);
        } catch {
          throw new MigrationError(`migrazione ${name} non riuscita all'istruzione ${i + 1}`, name, i + 1);
        }
      }
      await client.query(
        "INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
        [name, sum],
      );
      applied.push(name);
      logger.info({ name, sha: sum.slice(0, 7), statements: statements.length, durationMs: Date.now() - started }, "Migrazione applicata");
    }
    return { baselined, applied };
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY.toString()]);
    } finally {
      client.release();
    }
  }
}

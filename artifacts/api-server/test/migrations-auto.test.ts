// Prova dei file di migrazione: nomi, insieme di base, e per ogni file nuovo non distruttivo e idempotente.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { BASELINE_MIGRATIONS, LEGACY_APPLIED_BY_DEPLOY } from "../src/lib/migrations/baseline";
import { migrationsDir } from "../src/lib/migrations/config";
import { MIGRATION_NAME_RE, classifyMigration, isPostMigration } from "../src/lib/migrations/classify";
import { splitSql } from "../src/lib/migrations/split";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const dir = join(repoRoot, "docs", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const baseline = new Set(BASELINE_MIGRATIONS);
const legacyByDeploy = new Set(LEGACY_APPLIED_BY_DEPLOY);
const fresh = files.filter((f) => !baseline.has(f) && !isPostMigration(f));

describe("file di migrazione", () => {
  it("la cartella è leggibile e l'insieme di base è presente", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of BASELINE_MIGRATIONS) expect(files).toContain(f);
  });

  it("BASELINE_MIGRATIONS + LEGACY_APPLIED_BY_DEPLOY = file non -post che non rispettano il nome standard", () => {
    const legacy = files.filter((f) => !isPostMigration(f) && !MIGRATION_NAME_RE.test(f));
    expect([...baseline, ...legacyByDeploy].sort()).toEqual(legacy);
    for (const f of legacyByDeploy) expect(baseline.has(f), f).toBe(false);
  });

  it("ogni file non -post fuori dall'insieme di base rispetta il nome standard", () => {
    for (const f of files.filter((x) => !baseline.has(x) && !legacyByDeploy.has(x) && !isPostMigration(x))) {
      expect(MIGRATION_NAME_RE.test(f), f).toBe(true);
    }
  });

  for (const f of fresh) {
    it(`${f}: non distruttivo e idempotente`, async () => {
      const sql = readFileSync(join(dir, f), "utf8");
      expect(classifyMigration(f, sql)).toEqual({ destructive: false, reasons: [] });
      const db = await PGlite.create();
      try {
        await db.exec(readFileSync(join(repoRoot, "docs", "schema-casello.sql"), "utf8"));
        for (let pass = 0; pass < 2; pass++) {
          for (const statement of splitSql(sql)) await db.exec(statement);
        }
      } finally {
        await db.close();
      }
    }, 60_000);
  }
});

describe("migrationsDir", () => {
  const saved = { dir: process.env["MIGRATIONS_DIR"], env: process.env["NODE_ENV"] };
  afterEach(() => {
    if (saved.dir === undefined) delete process.env["MIGRATIONS_DIR"];
    else process.env["MIGRATIONS_DIR"] = saved.dir;
    process.env["NODE_ENV"] = saved.env;
  });

  it("usa MIGRATIONS_DIR se impostata", () => {
    process.env["MIGRATIONS_DIR"] = "/tmp/x";
    expect(migrationsDir()).toBe("/tmp/x");
  });

  it("in produzione default /app/migrations", () => {
    delete process.env["MIGRATIONS_DIR"];
    process.env["NODE_ENV"] = "production";
    expect(migrationsDir()).toBe("/app/migrations");
  });

  it("fuori produzione trova docs/migrations", () => {
    delete process.env["MIGRATIONS_DIR"];
    process.env["NODE_ENV"] = "test";
    expect(readdirSync(migrationsDir())).toContain("2026-10-account-ai.sql");
  });
});

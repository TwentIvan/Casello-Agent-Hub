import { describe, expect, it } from "vitest";
import { classifyMigration, isPostMigration, MIGRATION_NAME_RE } from "./classify.js";

const ok = "2026-11-16-a.sql";

describe("classifyMigration", () => {
  it("un \\r da solo chiude il commento -- come un a capo (stesso esito dell'esecutore)", () => {
    expect(classifyMigration(ok, "-- nota\rDROP TABLE t;\n")).toMatchObject({ destructive: true, reasons: ["DROP TABLE"] });
    expect(classifyMigration(ok, "-- nota\r\nDROP TABLE t;\r\n")).toMatchObject({ destructive: true, reasons: ["DROP TABLE"] });
    expect(classifyMigration(ok, "-- DROP TABLE t;\rSELECT 1;\n")).toEqual({ destructive: false, reasons: [] });
  });

  it("un file -post è distruttivo anche con SQL innocuo", () => {
    expect(classifyMigration("2026-11-16-a-post.sql", "SELECT 1;")).toEqual({
      destructive: true,
      reasons: ["-post"],
    });
  });

  const destructive: [string, string][] = [
    ["DROP TABLE t;", "DROP TABLE"],
    ["ALTER TABLE t DROP COLUMN c;", "DROP COLUMN"],
    ["ALTER TABLE t DROP c;", "DROP COLUMN"],
    ["DROP TYPE e;", "DROP TYPE"],
    ["DROP INDEX i;", "DROP INDEX"],
    ["DROP VIEW v;", "DROP VIEW"],
    ["DROP FUNCTION f();", "DROP FUNCTION"],
    ["ALTER TABLE t RENAME TO u;", "RENAME"],
    ["ALTER TYPE e RENAME VALUE 'a' TO 'b';", "RENAME"],
    ["TRUNCATE t;", "TRUNCATE"],
    ["DELETE FROM t;", "DELETE FROM"],
    ["ALTER TABLE t ALTER COLUMN c TYPE text;", "ALTER COLUMN TYPE"],
    ["ALTER TABLE t ALTER COLUMN c SET DATA TYPE int;", "ALTER COLUMN TYPE"],
    ["ALTER TABLE t ALTER COLUMN c SET NOT NULL;", "SET NOT NULL"],
    ["DO $$ BEGIN DROP TABLE x; END $$;", "DROP TABLE"],
    ['ALTER TABLE "a--b" DROP COLUMN c;', "DROP COLUMN"],
    ['ALTER TABLE t ALTER COLUMN "a b" TYPE text;', "ALTER COLUMN TYPE"],
    ['ALTER TABLE t ALTER COLUMN "a b" SET NOT NULL;', "SET NOT NULL"],
    ["DROP SCHEMA s;", "DROP SCHEMA"],
    ["DROP SEQUENCE q;", "DROP SEQUENCE"],
    ["DROP MATERIALIZED VIEW m;", "DROP MATERIALIZED VIEW"],
    ["ALTER TABLE t DROP CONSTRAINT k, DROP COLUMN c;", "DROP COLUMN"],
  ];
  it.each(destructive)("%s è distruttivo", (sql, reason) => {
    const r = classifyMigration(ok, sql);
    expect(r.destructive).toBe(true);
    expect(r.reasons).toContain(reason);
  });

  const additive = [
    "ALTER TABLE t DROP CONSTRAINT IF EXISTS k;",
    "ALTER TABLE t ALTER COLUMN c DROP NOT NULL;",
    "ALTER TABLE t ALTER COLUMN c DROP DEFAULT;",
    "UPDATE t SET a = 1;",
    "INSERT INTO t VALUES (1);",
    "ALTER TYPE e ADD VALUE IF NOT EXISTS 'x';",
    "CREATE TABLE IF NOT EXISTS t (id int);",
    "-- DROP TABLE x\nSELECT 1;",
    "/* DELETE FROM t */ SELECT 1;",
    "SELECT 'drop table x';",
  ];
  it.each(additive)("%s è additivo", (sql) => {
    expect(classifyMigration(ok, sql)).toEqual({ destructive: false, reasons: [] });
  });

  it("reasons non contiene il testo dell'istruzione", () => {
    const r = classifyMigration(ok, "DELETE FROM segreti WHERE token = 'abc';");
    expect(r.reasons).toEqual(["DELETE FROM"]);
  });
});

describe("nomi dei file", () => {
  it("MIGRATION_NAME_RE", () => {
    expect(MIGRATION_NAME_RE.test("2026-11-16-a-b.sql")).toBe(true);
    expect(MIGRATION_NAME_RE.test("2026-11-16-a-post.sql")).toBe(true);
    expect(MIGRATION_NAME_RE.test("2026-11-a.sql")).toBe(false);
    expect(MIGRATION_NAME_RE.test("2026-11-16-A.sql")).toBe(false);
  });
  it("isPostMigration", () => {
    expect(isPostMigration("2026-11-16-a-post.sql")).toBe(true);
    expect(isPostMigration("2026-11-16-a.sql")).toBe(false);
  });
});

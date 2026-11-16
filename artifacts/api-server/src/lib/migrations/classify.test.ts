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
    ["DELETE FROM t;", "DELETE"],
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
    // ogni DROP, non solo un elenco chiuso di oggetti
    ["DROP ROLE x;", "DROP ROLE"],
    ["DROP OWNED BY x;", "DROP OWNED"],
    ["DROP DATABASE other;", "DROP DATABASE"],
    ["DROP RULE r ON t;", "DROP RULE"],
    ["DROP AGGREGATE a(int);", "DROP AGGREGATE"],
    ["DROP PUBLICATION p;", "DROP PUBLICATION"],
    ["drop   table\n t;", "DROP TABLE"],
    ["DROP \"t\";", "DROP"],
    // ogni DELETE, anche fuori da DELETE FROM
    ["MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE;", "DELETE"],
    ["WITH d AS (DELETE FROM t RETURNING 1) SELECT 1;", "DELETE"],
    ["CREATE RULE r AS ON DELETE TO t DO INSTEAD NOTHING;", "DELETE"],
    // SQL dinamico: le parole nelle stringhe dentro i corpi si vedono
    ["DO $$ BEGIN IF EXISTS (SELECT 1) THEN EXECUTE 'ALTER TABLE t DROP COLUMN c'; END IF; END $$;", "DROP COLUMN"],
    ["DO $b$ BEGIN EXECUTE 'DELETE' || ' FROM t'; END $b$;", "DELETE"],
    ["DO $$ BEGIN EXECUTE 'SELECT 1 --'; EXECUTE 'DROP TABLE t'; END $$;", "DROP TABLE"],
    ["DO 'BEGIN EXECUTE ''DROP TABLE t''; END';", "DROP TABLE"],
    ["CREATE FUNCTION f() RETURNS void LANGUAGE sql AS 'DELETE FROM t';", "DELETE"],
    ["SELECT dblink_exec('dbname=x', 'DROP TABLE t');", "DROP TABLE"],
    ["SELECT query_to_xml('DELETE FROM t RETURNING 1', true, true, '');", "DELETE"],
    // stringhe E con escape a barra rovesciata: split e strip restano allineati
    ["SELECT E'\\''; DROP TABLE t; --'", "DROP TABLE"],
    ["SELECT e'\\\\'; DROP TABLE t;", "DROP TABLE"],
    ["WITH x AS (SELECT E'\\''), d AS (DELETE FROM t RETURNING 1) SELECT 1;", "DELETE"],
    // IDENTITY ed EXPRESSION non sono riservate: dopo ALTER TABLE sono nomi di colonna
    ["ALTER TABLE t DROP identity;", "DROP COLUMN"],
    ["ALTER TABLE t DROP expression CASCADE;", "DROP COLUMN"],
    ["ALTER TABLE t ALTER COLUMN c DROP DEFAULT, DROP identity;", "DROP COLUMN"],
    ["DO $$ BEGIN ALTER TABLE t DROP identity; END $$;", "DROP COLUMN"],
    // impostazioni che cambiano la lettura delle stringhe: split non sarebbe più allineato al server
    ["SET standard_conforming_strings = off;", "impostazione di sessione"],
    ["SELECT set_config('standard_conforming_strings', 'off', false);", "impostazione di sessione"],
    ["SET client_encoding = 'SJIS';", "impostazione di sessione"],
    ["SET NAMES 'SJIS';", "impostazione di sessione"],
    ["SET backslash_quote = on;", "impostazione di sessione"],
    ["ALTER DATABASE d SET standard_conforming_strings TO off;", "impostazione di sessione"],
    // comandi del sistema e SQL in background
    ["COPY t TO PROGRAM 'rm -rf /';", "COPY PROGRAM"],
    ["SELECT pg_background_launch('DROP TABLE t');", "DROP TABLE"],
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
    "SELECT E'drop table x';",
    "SELECT E'it\\'s; drop table x';",
    "CREATE TABLE IF NOT EXISTS t (id int, p int REFERENCES p(id) ON DELETE CASCADE);",
    "ALTER TABLE t ADD CONSTRAINT k FOREIGN KEY (p) REFERENCES p(id) ON DELETE SET NULL;",
    "ALTER TABLE t ADD FOREIGN KEY (p) REFERENCES p(id) ON DELETE NO ACTION ON UPDATE RESTRICT;",
    "ALTER TABLE t ADD COLUMN deleted_at timestamp, ADD COLUMN dropped boolean;",
    "ALTER TYPE e ADD VALUE IF NOT EXISTS 'deleted';",
    "ALTER TABLE t ALTER COLUMN c DROP IDENTITY IF EXISTS;",
    "ALTER TABLE t ALTER COLUMN c DROP EXPRESSION;",
    "DO $$ BEGIN ALTER TABLE t DROP CONSTRAINT IF EXISTS k; END $$;",
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'e') THEN CREATE TYPE e AS ENUM ('a'); END IF; END $$;",
    "SELECT selected FROM t WHERE e'' = '';",
    "ALTER TABLE t ALTER COLUMN c DROP IDENTITY;",
    "ALTER TABLE t ALTER c DROP EXPRESSION IF EXISTS;",
    'ALTER TABLE t ALTER COLUMN "identity" DROP IDENTITY IF EXISTS;',
  ];
  it.each(additive)("%s è additivo", (sql) => {
    expect(classifyMigration(ok, sql)).toEqual({ destructive: false, reasons: [] });
  });

  it("standard_conforming_strings spento prima di una stringa con \\': distruttivo", () => {
    const sql = "SET standard_conforming_strings = off;\nSELECT '\\''; DROP TABLE t; --';\n";
    expect(classifyMigration(ok, sql)).toMatchObject({ destructive: true });
    expect(classifyMigration(ok, sql).reasons).toContain("impostazione di sessione");
  });

  it("reasons non contiene il testo dell'istruzione", () => {
    const r = classifyMigration(ok, "DELETE FROM segreti WHERE token = 'abc';");
    expect(r.reasons).toEqual(["DELETE"]);
    expect(classifyMigration(ok, "ALTER TABLE segreti DROP token;").reasons).toEqual(["DROP", "DROP COLUMN"]);
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

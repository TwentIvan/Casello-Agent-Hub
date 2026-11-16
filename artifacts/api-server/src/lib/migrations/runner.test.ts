import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeExtendedProtocol } from "../../../test/pglite-protocol";
import { errorCode, extendedQuery, MigrationError, runMigrations } from "./runner";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let dbPglite: PGlite;
let server: PGLiteSocketServer;
let port: number;

beforeAll(async () => {
  dbPglite = await PGlite.create();
  serializeExtendedProtocol(dbPglite);
  port = await freePort();
  server = new PGLiteSocketServer({ db: dbPglite, port, host: "127.0.0.1", maxConnections: 10 });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  await dbPglite.close();
});

let pool: pg.Pool;
let dir: string;
const logger = { info: vi.fn(), warn: vi.fn() };

beforeEach(async () => {
  // Database pulito a ogni test
  await dbPglite.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable` });
  dir = mkdtempSync(join(tmpdir(), "migr-"));
  logger.info.mockClear();
  logger.warn.mockClear();
});

afterEach(async () => {
  await pool.end();
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
const run = (baseline: string[] = []) => runMigrations({ pool, dir, logger, baseline });
const tableExists = async (t: string) =>
  (await pool.query("SELECT to_regclass($1) AS r", [`public.${t}`])).rows[0].r !== null;
const registered = async () =>
  (await pool.query("SELECT name, sha256, baseline FROM schema_migrations ORDER BY name")).rows;

describe("runMigrations", () => {
  it("registra l'elenco iniziale senza eseguire, poi applica solo i nuovi", async () => {
    const a = "SELECT * FROM nonesiste;";
    write("2026-10-a.sql", a);
    expect(await run(["2026-10-a.sql"])).toEqual({ baselined: 1, applied: [] });
    expect(await registered()).toEqual([{ name: "2026-10-a.sql", sha256: sha(a), baseline: true }]);

    write("2026-11-16-b.sql", "CREATE TABLE IF NOT EXISTS b (id int);");
    expect(await run(["2026-10-a.sql"])).toEqual({ baselined: 0, applied: ["2026-11-16-b.sql"] });
    expect(await tableExists("b")).toBe(true);
    expect(await run(["2026-10-a.sql"])).toEqual({ baselined: 0, applied: [] });
  });

  it("applica in ordine di nome", async () => {
    write("2026-11-17-a.sql", "INSERT INTO b VALUES (1);");
    write("2026-11-16-b.sql", "CREATE TABLE IF NOT EXISTS b (id int);");
    const r = await run();
    expect(r.applied).toEqual(["2026-11-16-b.sql", "2026-11-17-a.sql"]);
  });

  it("ignora i file -post", async () => {
    write("x-post.sql", "CREATE TABLE p (id int);");
    expect((await run()).applied).toEqual([]);
    expect(await tableExists("p")).toBe(false);
    expect(await registered()).toEqual([]);
  });

  it("avvisa se un file registrato è cambiato, senza rieseguirlo", async () => {
    write("2026-11-16-b.sql", "CREATE TABLE IF NOT EXISTS b (id int);");
    await run();
    write("2026-11-16-b.sql", "CREATE TABLE IF NOT EXISTS b2 (id int);");
    expect((await run()).applied).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
    expect(await tableExists("b2")).toBe(false);
  });

  it("rifiuta una migrazione distruttiva fuori da un file -post", async () => {
    write("2026-11-16-d.sql", "DROP TABLE x;");
    await expect(run()).rejects.toThrow(/migrazione distruttiva fuori da un file -post: 2026-11-16-d.sql/);
    expect(await registered()).toEqual([]);
  });

  it("segnala file e istruzione che falliscono, e riparte dall'inizio dopo la correzione", async () => {
    write("2026-11-16-c.sql", "CREATE TABLE c (id int); SELECT * FROM nonesiste;");
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.file).toBe("2026-11-16-c.sql");
    expect(err.statement).toBe(2);
    expect(err.message).toBe("migrazione 2026-11-16-c.sql non riuscita all'istruzione 2");
    expect(await registered()).toEqual([]);
    expect(await tableExists("c")).toBe(true);

    write("2026-11-16-c.sql", "CREATE TABLE IF NOT EXISTS c (id int);");
    expect((await run()).applied).toEqual(["2026-11-16-c.sql"]);
  });

  it("usa un valore di enum aggiunto nello stesso file", async () => {
    write(
      "2026-11-16-e.sql",
      "CREATE TYPE e AS ENUM ('a'); ALTER TYPE e ADD VALUE IF NOT EXISTS 'b'; CREATE TABLE t (v e DEFAULT 'b');",
    );
    expect((await run()).applied).toEqual(["2026-11-16-e.sql"]);
  });

  it("protocollo esteso: ADD VALUE, DO $$, BEGIN/COMMIT e CREATE INDEX funzionano", async () => {
    write(
      "2026-11-16-p.sql",
      [
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pe') THEN CREATE TYPE pe AS ENUM ('a'); END IF; END $$;",
        "ALTER TYPE pe ADD VALUE IF NOT EXISTS 'b';",
        "BEGIN;",
        "CREATE TABLE IF NOT EXISTS p (id int, v pe DEFAULT 'b');",
        "COMMIT;",
        "CREATE INDEX IF NOT EXISTS p_id_idx ON p (id);",
        "INSERT INTO p (id) VALUES (1);",
      ].join("\n"),
    );
    expect((await run()).applied).toEqual(["2026-11-16-p.sql"]);
    const { rows } = await pool.query("SELECT v::text AS v FROM p");
    expect(rows).toEqual([{ v: "b" }]);
    expect((await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'p_id_idx'")).rowCount).toBe(1);
  });

  it("protocollo esteso: un pezzo che il server leggerebbe come più istruzioni è rifiutato", async () => {
    // Il classificatore lo considera distruttivo: qui si prova solo l'esecutore (elenco iniziale vuoto, rifiuto del protocollo)
    const pg2 = await pool.connect();
    try {
      const err = await pg2.query(extendedQuery("CREATE TABLE IF NOT EXISTS m1 (id int); CREATE TABLE IF NOT EXISTS m2 (id int)")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(await tableExists("m1")).toBe(false);
    } finally {
      pg2.release();
    }
  });

  it("gestisce i file con CRLF", async () => {
    write("2026-11-16-f.sql", "CREATE TABLE IF NOT EXISTS f (id int);\r\n-- nota\r\nCREATE TABLE IF NOT EXISTS g (id int);\r\n");
    expect((await run()).applied).toEqual(["2026-11-16-f.sql"]);
    expect(await tableExists("g")).toBe(true);
  });

  it("mantiene l'errore originale se il file con BEGIN esplicito fallisce a metà", async () => {
    write("2026-11-16-t.sql", "BEGIN; CREATE TABLE x (id int); SELECT * FROM nonesiste; COMMIT;");
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.file).toBe("2026-11-16-t.sql");
    expect(err.statement).toBe(3);
    expect(err.code).toBe("42P01");
    expect(await registered()).toEqual([]);
  });

  it("registra l'elenco iniziale in blocco", async () => {
    write("2026-10-a.sql", "SELECT 1;");
    write("2026-10-b.sql", "SELECT 2;");
    expect(await run(["2026-10-a.sql", "2026-10-b.sql", "2026-10-assente.sql"])).toEqual({ baselined: 2, applied: [] });
    expect((await registered()).map((r) => r.name)).toEqual(["2026-10-a.sql", "2026-10-b.sql"]);
  });

  describe("lock", () => {
    function recording() {
      const log: string[] = [];
      const wrapped = {
        connect: async () => {
          const c = await pool.connect();
          return new Proxy(c, {
            get(t, p) {
              if (p === "query")
                return (q: unknown, ...rest: unknown[]) => {
                  log.push(typeof q === "string" ? q : (q as { text: string }).text);
                  return (t.query as (...a: unknown[]) => unknown)(q, ...rest);
                };
              if (p === "release")
                return (...a: unknown[]) => {
                  log.push("release");
                  return (t.release as (...a: unknown[]) => void)(...a);
                };
              const v = Reflect.get(t, p);
              return typeof v === "function" ? v.bind(t) : v;
            },
          });
        },
      } as unknown as pg.Pool;
      return { log, wrapped };
    }

    it("prende il lock prima di leggere il registro e lo rilascia per ultimo", async () => {
      write("2026-11-16-b.sql", "CREATE TABLE IF NOT EXISTS b (id int);");
      const { log, wrapped } = recording();
      await runMigrations({ pool: wrapped, dir, logger, baseline: [] });
      const lock = log.findIndex((q) => q.includes("pg_advisory_lock"));
      const firstRead = log.findIndex((q) => q.includes("schema_migrations"));
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(log.findIndex((q) => q.includes("lock_timeout")));
      expect(lock).toBeLessThan(firstRead);
      expect(log[log.length - 2]).toContain("pg_advisory_unlock");
      expect(log[log.length - 1]).toBe("release");
    });

    it("rilascia lock e connessione anche se una migrazione fallisce", async () => {
      write("2026-11-16-c.sql", "SELECT * FROM nonesiste;");
      const { log, wrapped } = recording();
      await expect(runMigrations({ pool: wrapped, dir, logger, baseline: [] })).rejects.toBeInstanceOf(MigrationError);
      expect(log[log.length - 2]).toContain("pg_advisory_unlock");
      expect(log[log.length - 1]).toBe("release");
    });
  });
});

describe("errorCode", () => {
  it("solo un codice stringa: SQLSTATE o di sistema, mai il messaggio", () => {
    expect(errorCode(Object.assign(new Error("connessione rifiutata"), { code: "ECONNREFUSED" }))).toBe("ECONNREFUSED");
    expect(errorCode({ code: "55P03", message: "lock timeout" })).toBe("55P03");
    expect(errorCode(Object.assign(new Error("x"), { code: 42 }))).toBeUndefined();
    expect(errorCode(new Error("x"))).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode("ENOENT")).toBeUndefined();
  });
});

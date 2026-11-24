import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-11-24-drop-ai-provider-post.sql";

describe("migrazione 2026-11-24-drop-ai-provider-post", () => {
  let db: PGlite;

  beforeEach(async () => {
    // schema attuale più l'enum rimasto nel DB di produzione
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec(`CREATE TYPE "public"."ai_provider" AS ENUM('deepseek', 'gemini', 'custom', 'system_gateway');`);
  });

  afterEach(async () => {
    await db.close();
  });

  const enumCount = async () =>
    (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_type WHERE typname = 'ai_provider'")).rows[0].n;

  it("lo schema dei test non ha l'enum ai_provider", async () => {
    const fresh = new PGlite();
    await fresh.exec(read("../../../docs/schema-casello.sql"));
    expect((await fresh.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_type WHERE typname = 'ai_provider'")).rows[0].n).toBe(0);
    await fresh.close();
  });

  it("elimina l'enum inutilizzato", async () => {
    await db.exec(read(SQL));
    expect(await enumCount()).toBe(0);
  });

  it("è idempotente", async () => {
    await db.exec(read(SQL));
    await db.exec(read(SQL));
    expect(await enumCount()).toBe(0);
  });

  it("si ferma senza modifiche se una colonna usa ancora l'enum", async () => {
    await db.exec(`CREATE TABLE vecchia (p "ai_provider");`);
    await expect(db.exec(read(SQL))).rejects.toThrow(/ancora usato da 1 colonne/);
    await db.exec("ROLLBACK").catch(() => {});
    expect(await enumCount()).toBe(1);
  });

  it("si ferma anche con una colonna array dell'enum", async () => {
    await db.exec(`CREATE TABLE vecchia (p "ai_provider"[]);`);
    await expect(db.exec(read(SQL))).rejects.toThrow(/ancora usato/);
    await db.exec("ROLLBACK").catch(() => {});
    expect(await enumCount()).toBe(1);
  });
});

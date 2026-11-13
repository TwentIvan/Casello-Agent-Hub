import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-spazio-di-lavoro-automatico", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema di produzione dopo il nodo locale, con un nodo già registrato; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-locale.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('a@example.com');
      INSERT INTO nodes (user_id, name) SELECT id, 'mac' FROM users;
    `);
    await db.exec(read("../../../docs/migrations/2026-11-spazio-di-lavoro-automatico.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-spazio-di-lavoro-automatico.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("aggiunge git_status, null sui nodi esistenti", async () => {
    const r = await db.query<any>("SELECT name, git_status FROM nodes");
    expect(r.rows).toEqual([{ name: "mac", git_status: null }]);
  });

  it("la colonna è jsonb nullable e sta in schema-casello.sql", async () => {
    const r = await db.query<any>(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'nodes' AND column_name = 'git_status'",
    );
    expect(r.rows).toEqual([{ data_type: "jsonb", is_nullable: "YES" }]);
    expect(read("../../../docs/schema-casello.sql")).toContain('ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "git_status" jsonb;');
  });
});

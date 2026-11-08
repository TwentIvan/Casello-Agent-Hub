import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-header-app", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema di produzione con un'app già registrata; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(`INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com');`);
    await db.exec(read("../../../docs/migrations/2026-11-header-app.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-header-app.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("aggiunge extra_headers, vuoto sulle app esistenti e non nullo", async () => {
    const r = await db.query<any>("SELECT slug, extra_headers FROM apps");
    expect(r.rows).toEqual([{ slug: "app", extra_headers: [] }]);
    await expect(db.exec("UPDATE apps SET extra_headers = NULL")).rejects.toThrow();
  });

  it("la colonna è quella di schema-casello.sql", async () => {
    expect(read("../../../docs/schema-casello.sql")).toContain(
      `ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "extra_headers" jsonb DEFAULT '[]'::jsonb NOT NULL;`,
    );
  });
});

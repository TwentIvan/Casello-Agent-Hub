import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-nodo-cartelle", () => {
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
    await db.exec(read("../../../docs/migrations/2026-11-nodo-cartelle.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-cartelle.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("aggiunge le colonne, null sui nodi esistenti", async () => {
    const r = await db.query<any>("SELECT name, workspace_folders, folders_updated_at FROM nodes");
    expect(r.rows).toEqual([{ name: "mac", workspace_folders: null, folders_updated_at: null }]);
  });

  it("le colonne sono quelle di schema-casello.sql", async () => {
    const r = await db.query<any>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'nodes' AND column_name IN ('workspace_folders', 'folders_updated_at') ORDER BY column_name",
    );
    expect(r.rows).toEqual([
      { column_name: "folders_updated_at", data_type: "timestamp without time zone" },
      { column_name: "workspace_folders", data_type: "jsonb" },
    ]);
    expect(read("../../../docs/schema-casello.sql")).toContain('"workspace_folders" jsonb,\n\t"folders_updated_at" timestamp,');
  });
});

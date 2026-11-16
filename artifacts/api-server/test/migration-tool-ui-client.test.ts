import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-tool-ui-client", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema di produzione con una run già presente; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-cartelle.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-thu-5c-tappa1.sql"));
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com');
      INSERT INTO agents (app_id, name, role) SELECT id, 'Agente', 'general' FROM apps;
      INSERT INTO runs (agent_id) SELECT id FROM agents;
    `);
    await db.exec(read("../../../docs/migrations/2026-11-tool-ui-client.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-tool-ui-client.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("le run esistenti non hanno client né azione in attesa", async () => {
    const r = await db.query<any>("SELECT client_tools, client_action FROM runs");
    expect(r.rows).toEqual([{ client_tools: false, client_action: null }]);
  });

  it("colonne e tipi", async () => {
    const r = await db.query<any>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'runs' AND column_name IN ('client_tools', 'client_action') ORDER BY column_name`,
    );
    expect(r.rows).toEqual([
      { column_name: "client_action", data_type: "jsonb", is_nullable: "YES", column_default: null },
      { column_name: "client_tools", data_type: "boolean", is_nullable: "NO", column_default: "false" },
    ]);
  });
});

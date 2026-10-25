import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-10-fase-1", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio, separato da quello del global setup: parte dallo schema precedente alla fase 1
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-fase-1.sql"));
    await db.exec(`
      INSERT INTO apps (name, base_url) VALUES ('Mister App', 'http://a'), ('Mister App', 'http://b');
      INSERT INTO agents (app_id, name) VALUES (1, 'Agente uno');
      INSERT INTO tools (agent_id, name, description, http_method, endpoint, parameters_schema) VALUES
        (1, 'cerca', 'Cerca', 'GET', '/api/cerca', '{"type":"object","properties":{"q":{"type":"string"}}}'),
        (1, 'rotto', NULL, 'POST', '/api/rotto', 'non è json {');
    `);
    await db.exec(read("../../../docs/migrations/2026-10-fase-1.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("assegna slug distinti alle app con lo stesso nome", async () => {
    const { rows } = await db.query<{ slug: string }>("SELECT slug FROM apps ORDER BY id");
    expect(rows[0]!.slug).toBe("mister-app");
    expect(rows[1]!.slug).toBe("mister-app-2");
  });

  it("converte i tool in app_tools in bozza e li collega all'agente", async () => {
    const { rows } = await db.query<{
      name: string;
      kind: string;
      status: string;
      params_schema: unknown;
      definition: unknown;
      app_id: number;
    }>("SELECT * FROM app_tools ORDER BY id");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "draft" && r.kind === "http" && r.app_id === 1)).toBe(true);
    expect(rows[0]!.definition).toEqual({ method: "GET", path: "/api/cerca", paramLocations: {} });
    const links = await db.query("SELECT * FROM agent_tools WHERE agent_id = 1");
    expect(links.rows).toHaveLength(2);
  });

  it("copia lo schema valido e usa quello vuoto per l'invalido", async () => {
    const { rows } = await db.query<{ params_schema: unknown }>("SELECT params_schema FROM app_tools ORDER BY id");
    expect(rows[0]!.params_schema).toEqual({ type: "object", properties: { q: { type: "string" } } });
    expect(rows[1]!.params_schema).toEqual({ type: "object", properties: {} });
  });

  it("crea un agente general per ogni app e lascia 'area' agli esistenti", async () => {
    const { rows } = await db.query<{ app_id: number; role: string; name: string; status: string }>(
      "SELECT app_id, role, name, status FROM agents ORDER BY id",
    );
    expect(rows[0]).toMatchObject({ app_id: 1, role: "area" });
    const general = rows.filter((r) => r.role === "general");
    expect(general.map((r) => r.app_id).sort()).toEqual([1, 2]);
    expect(general.every((r) => r.status === "draft")).toBe(true);
    expect(general[0]!.name).toBe("Mister App – generale");
  });

  it("è idempotente: una seconda esecuzione non cambia i dati", async () => {
    await db.exec(read("../../../docs/migrations/2026-10-fase-1.sql"));
    expect((await db.query("SELECT 1 FROM app_tools")).rows).toHaveLength(2);
    expect((await db.query("SELECT 1 FROM agents WHERE role = 'general'")).rows).toHaveLength(2);
    expect((await db.query("SELECT 1 FROM agent_tools")).rows).toHaveLength(2);
  });

  it("elimina la tabella tools", async () => {
    const { rows } = await db.query("SELECT to_regclass('public.tools') AS t");
    expect(rows[0]).toEqual({ t: null });
  });
});

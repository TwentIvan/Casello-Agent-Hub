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
    const longName = "x".repeat(70);
    await db.exec(`
      INSERT INTO apps (name, base_url) VALUES
        ('Mister App', 'http://a'), ('Mister App', 'http://b'), ('mister-app-2', 'http://c'), ('Altra', 'http://d');
      INSERT INTO agents (app_id, name) VALUES (1, 'Agente uno'), (4, 'Agente due'), (4, 'Agente tre');
      INSERT INTO tools (agent_id, name, description, http_method, endpoint, parameters_schema) VALUES
        (1, 'cerca', 'Cerca', 'GET', '/api/cerca', '{"type":"object","properties":{"q":{"type":"string"}}}'),
        (1, 'rotto', NULL, 'POST', '/api/rotto', 'non è json {'),
        (1, 'nullo', NULL, 'GET', '/api/nullo', NULL),
        (1, 'array', NULL, 'GET', '/api/array', '[]'),
        (1, 'senza tipo', NULL, 'GET', '/api/st', '{"properties":{}}'),
        (1, 'Elenco giocatori è', NULL, 'GET', '/api/el', NULL),
        (1, '${longName}', NULL, 'GET', '/api/long', NULL),
        (2, 'cerca', NULL, 'GET', '/api/c1', NULL),
        (3, 'cerca', NULL, 'GET', '/api/c2', NULL);
    `);
    await db.exec(read("../../../docs/migrations/2026-10-fase-1.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("assegna slug distinti, anche quando il suffisso collide con uno slug esistente", async () => {
    const { rows } = await db.query<{ slug: string }>("SELECT slug FROM apps ORDER BY id");
    expect(rows.map((r) => r.slug)).toEqual(["mister-app", "mister-app-2", "mister-app-2-3", "altra"]);
  });

  const empty = { type: "object", properties: {} };
  const byName = async (name: string) =>
    (await db.query<{ params_schema: unknown; definition: unknown; status: string; kind: string }>(
      "SELECT * FROM app_tools WHERE name = $1",
      [name],
    )).rows[0]!;

  it("converte i tool in app_tools in bozza e li collega agli agenti", async () => {
    const { rows } = await db.query<{ status: string; kind: string }>("SELECT * FROM app_tools");
    expect(rows).toHaveLength(9);
    expect(rows.every((r) => r.status === "draft" && r.kind === "http")).toBe(true);
    expect((await db.query("SELECT * FROM agent_tools")).rows).toHaveLength(9);
    expect((await byName("cerca")).definition).toEqual({ method: "GET", path: "/api/cerca", paramLocations: {} });
  });

  it("copia lo schema valido e usa quello vuoto per invalido, NULL, array e senza type object", async () => {
    expect((await byName("cerca")).params_schema).toEqual({ type: "object", properties: { q: { type: "string" } } });
    for (const n of ["rotto", "nullo", "array", "senza_tipo"]) expect((await byName(n)).params_schema).toEqual(empty);
  });

  it("normalizza i nomi a [a-zA-Z0-9_-]{1,64}", async () => {
    const { rows } = await db.query<{ name: string }>("SELECT name FROM app_tools");
    expect(rows.every((r) => /^[a-zA-Z0-9_-]{1,64}$/.test(r.name))).toBe(true);
    expect(await byName("elenco_giocatori_e")).toBeTruthy();
    expect(rows.some((r) => r.name === "x".repeat(50))).toBe(true);
  });

  it("disambigua i nomi uguali di agenti diversi della stessa app", async () => {
    const { rows } = await db.query<{ name: string }>("SELECT name FROM app_tools WHERE app_id = 4 ORDER BY id");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe("cerca");
    expect(rows[1]!.name).toMatch(/^cerca-\d+$/);
    const links = await db.query("SELECT agent_id FROM agent_tools at JOIN app_tools t ON t.id = at.tool_id WHERE t.app_id = 4");
    expect(links.rows.map((r: any) => r.agent_id).sort()).toEqual([2, 3]);
  });

  it("crea un agente general per ogni app e lascia 'area' agli esistenti", async () => {
    const { rows } = await db.query<{ app_id: number; role: string; name: string; status: string }>(
      "SELECT app_id, role, name, status FROM agents ORDER BY id",
    );
    expect(rows.filter((r) => r.role === "area")).toHaveLength(3);
    const general = rows.filter((r) => r.role === "general");
    expect(general.map((r) => r.app_id).sort()).toEqual([1, 2, 3, 4]);
    expect(general.every((r) => r.status === "draft")).toBe(true);
    expect(general.find((r) => r.app_id === 1)!.name).toBe("Mister App – generale");
  });

  it("è idempotente: una seconda esecuzione non cambia i dati", async () => {
    await db.exec(read("../../../docs/migrations/2026-10-fase-1.sql"));
    expect((await db.query("SELECT 1 FROM app_tools")).rows).toHaveLength(9);
    expect((await db.query("SELECT 1 FROM agents WHERE role = 'general'")).rows).toHaveLength(4);
    expect((await db.query("SELECT 1 FROM agent_tools")).rows).toHaveLength(9);
  });

  it("elimina la tabella tools", async () => {
    const { rows } = await db.query("SELECT to_regclass('public.tools') AS t");
    expect(rows[0]).toEqual({ t: null });
  });
});

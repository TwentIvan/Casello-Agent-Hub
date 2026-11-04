import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-11-squadre.sql";

const TABLES = ["skills", "skill_versions", "team_templates", "team_template_versions", "team_instances", "team_instance_skills"];

describe("migrazione 2026-11-squadre", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente; lo script si applica due volte (idempotenza)
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-squadre.sql"));
    await db.exec(read(SQL));
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  it("crea le sei tabelle e i due enum", async () => {
    const t = await db.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
      [TABLES],
    );
    expect(t.rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort());
    const e = await db.query<any>("SELECT typname FROM pg_type WHERE typname IN ('skill_kind', 'team_instance_status')");
    expect(e.rows).toHaveLength(2);
  });

  it("il nome del modello è unico solo tra i non archiviati", async () => {
    await db.exec(`INSERT INTO team_templates (name) VALUES ('Dev')`);
    await expect(db.exec(`INSERT INTO team_templates (name) VALUES ('Dev')`)).rejects.toThrow(/unique|duplicate/i);
    await db.exec(`UPDATE team_templates SET archived = true WHERE name = 'Dev'`);
    await db.exec(`INSERT INTO team_templates (name) VALUES ('Dev')`);
    await db.exec(`INSERT INTO team_templates (name, archived) VALUES ('Dev', true)`);
    expect((await db.query<any>("SELECT count(*)::int AS n FROM team_templates")).rows[0].n).toBe(3);
  });

  it("versioni uniche per skill e codice unico", async () => {
    await db.exec(`INSERT INTO skills (code, name, kind) VALUES ('s.uno', 'Uno', 'casello')`);
    const v = `INSERT INTO skill_versions (skill_id, version, content) SELECT id, 1, 'x' FROM skills`;
    await db.exec(v);
    await expect(db.exec(v)).rejects.toThrow(/unique|duplicate/i);
    expect((await db.query<any>("SELECT tool_hints FROM skill_versions")).rows[0].tool_hints).toEqual([]);
    await expect(db.exec(`INSERT INTO skills (code, name, kind) VALUES ('s.uno', 'Bis', 'node')`)).rejects.toThrow(/unique|duplicate/i);
  });

  it("elimina un'app con un'istanza: rifiutato (FK RESTRICT)", async () => {
    await db.exec(`INSERT INTO apps (name, slug, base_url) VALUES ('App', 'app', 'https://app.example.com')`);
    await db.exec(`INSERT INTO team_instances (name, ref_app_id, ref_type, ref_id, ref_title)
      SELECT 'Squadra', id, 'wi', '1', 'Titolo' FROM apps`);
    const row = (await db.query<any>("SELECT status, roles FROM team_instances")).rows[0];
    expect(row).toEqual({ status: "draft", roles: [] });
    await expect(db.exec("DELETE FROM apps WHERE slug = 'app'")).rejects.toThrow(/foreign key|violates/i);
    expect((await db.query<any>("SELECT 1 FROM apps")).rows).toHaveLength(1);
  });

  it("le skill dell'istanza hanno codice unico per istanza e seguono l'istanza", async () => {
    const ins = `INSERT INTO team_instance_skills (instance_id, code, name, kind, content)
      SELECT id, 'c', 'C', 'casello', 'x' FROM team_instances`;
    await db.exec(ins);
    await expect(db.exec(ins)).rejects.toThrow(/unique|duplicate/i);
    await db.exec("DELETE FROM team_instances");
    expect((await db.query<any>("SELECT 1 FROM team_instance_skills")).rows).toHaveLength(0);
  });
});

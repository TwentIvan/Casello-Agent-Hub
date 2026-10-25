import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-fase-3.sql";

describe("migrazione 2026-10-fase-3", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente alla fase 3, con un'app già presente
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-fase-3.sql"));
    await db.exec(`INSERT INTO apps (name, slug, base_url) VALUES ('Mister', 'mister', 'http://a'), ('Altra', 'altra', 'http://b');`);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  const insertAnalysis = (appId: number, status: string) =>
    db.query(
      `INSERT INTO analyses (app_id, model, status, sources, max_tokens) VALUES ($1, 'openrouter/auto', $2, '{"code":"none"}', 400000)`,
      [appId, status],
    );

  it("aggiunge le colonne sorgente ad apps con source_type = 'none' per le app esistenti", async () => {
    const { rows } = await db.query<Record<string, unknown>>("SELECT * FROM apps ORDER BY id");
    for (const r of rows) {
      expect(r.source_type).toBe("none");
      for (const c of ["source_repo", "source_branch", "source_token_enc", "openapi_url", "functional_description"]) {
        expect(c in r).toBe(true);
        expect(r[c]).toBeNull();
      }
    }
  });

  it("crea le tabelle analyses, analysis_items e agent_skills", async () => {
    for (const t of ["analyses", "analysis_items", "agent_skills"]) {
      const { rows } = await db.query("SELECT to_regclass($1) AS t", [`public.${t}`]);
      expect(rows[0]).toEqual({ t });
    }
  });

  it("applica i default di analyses", async () => {
    await insertAnalysis(2, "completed");
    const { rows } = await db.query<any>("SELECT * FROM analyses WHERE app_id = 2");
    expect(rows[0].tokens_used).toBe(0);
    expect(rows[0].log).toEqual([]);
    expect(rows[0].finished_at).toBeNull();
  });

  it("ammette una sola analisi queued/running per app (indice unico parziale)", async () => {
    await insertAnalysis(1, "running");
    await expect(insertAnalysis(1, "running")).rejects.toThrow(/analyses_one_active_per_app/);
    await expect(insertAnalysis(1, "queued")).rejects.toThrow(/analyses_one_active_per_app/);
    await insertAnalysis(2, "running"); // altra app: ammessa
  });

  it("ammette una nuova analisi running dopo una completed", async () => {
    await db.exec("UPDATE analyses SET status = 'completed' WHERE app_id = 1");
    await insertAnalysis(1, "running");
    expect((await db.query("SELECT 1 FROM analyses WHERE app_id = 1")).rows).toHaveLength(2);
  });

  it("analysis_items: ref unico per analisi, default e cascade", async () => {
    const { rows } = await db.query<{ id: number }>("SELECT id FROM analyses WHERE app_id = 1 LIMIT 1");
    const id = rows[0]!.id;
    const ins = () =>
      db.query(
        `INSERT INTO analysis_items (analysis_id, chapter, ref, position, payload, diff) VALUES ($1, 'tool', 'tool:rosa', 0, '{}', 'new')`,
        [id],
      );
    await ins();
    await expect(ins()).rejects.toThrow();
    const item = (await db.query<any>("SELECT * FROM analysis_items")).rows[0];
    expect(item.status).toBe("pending");
    expect(item.evidence).toEqual([]);
    await db.exec("DELETE FROM apps WHERE id = 1");
    expect((await db.query("SELECT 1 FROM analysis_items")).rows).toHaveLength(0);
  });

  it("agent_skills: default, unicità (agent_id, name)", async () => {
    await db.exec(`INSERT INTO agents (app_id, name) VALUES (2, 'Ag')`);
    const { rows } = await db.query<{ id: number }>("SELECT id FROM agents LIMIT 1");
    const id = rows[0]!.id;
    const ins = () => db.query(`INSERT INTO agent_skills (agent_id, name, instructions) VALUES ($1, 'rosa', 'fai')`, [id]);
    await ins();
    await expect(ins()).rejects.toThrow();
    const s = (await db.query<any>("SELECT * FROM agent_skills")).rows[0];
    expect(s.status).toBe("active");
    expect(s.tool_names).toEqual([]);
  });

  it("è idempotente: una seconda esecuzione non cambia nulla", async () => {
    const before = (await db.query("SELECT count(*)::int AS n FROM analyses")).rows[0];
    await db.exec(read(SQL));
    expect((await db.query("SELECT count(*)::int AS n FROM analyses")).rows[0]).toEqual(before);
    expect((await db.query("SELECT 1 FROM apps WHERE source_type = 'none'")).rows).toHaveLength(1);
  });
});

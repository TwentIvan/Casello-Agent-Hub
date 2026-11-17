import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const MIGRATION = "../../../docs/migrations/2026-11-16-evoluzione-automatica.sql";

describe("migrazione 2026-11-16-evoluzione-automatica", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema attuale con un'app e un'analisi già esistenti (precedenti alla migrazione); lo script si applica due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec(`
      INSERT INTO apps (name, slug, base_url) VALUES ('Botcave', 'casello', 'https://app.example.com');
    `);
    await db.exec(read(MIGRATION));
    await db.exec(read(MIGRATION));
  });

  afterAll(async () => {
    await db.close();
  });

  it("un'analisi esistente ha mode = full e approved_by_cycle è falso", async () => {
    await db.exec(`
      INSERT INTO analyses (app_id, model, sources, max_tokens, status)
        SELECT id, 'm', '{"code":"none","openapi":false,"description":true}', 1000, 'completed' FROM apps;
      INSERT INTO analysis_items (analysis_id, chapter, ref, position, payload, diff)
        SELECT id, 'tool', 'tool:x', 0, '{}', 'new' FROM analyses;
    `);
    const a = await db.query<any>("SELECT mode, evolution_round_id FROM analyses");
    expect(a.rows).toEqual([{ mode: "full", evolution_round_id: null }]);
    const i = await db.query<any>("SELECT approved_by_cycle FROM analysis_items");
    expect(i.rows).toEqual([{ approved_by_cycle: false }]);
  });

  it("default del ciclo", async () => {
    await db.exec("INSERT INTO evolution_cycles (app_id, monthly_budget_usd) SELECT id, 5 FROM apps");
    const r = await db.query<any>(
      "SELECT status, frequency, items_per_round, merge_mode, consecutive_errors, paused_reason FROM evolution_cycles",
    );
    expect(r.rows).toEqual([
      { status: "active", frequency: "weekly", items_per_round: 3, merge_mode: "direct", consecutive_errors: 0, paused_reason: null },
    ]);
  });

  it("vincoli del ciclo: una riga per App, voci per giro 1..10, tetto positivo", async () => {
    await expect(db.exec("INSERT INTO evolution_cycles (app_id, monthly_budget_usd) SELECT id, 5 FROM apps")).rejects.toThrow();
    await expect(db.exec("UPDATE evolution_cycles SET items_per_round = 11")).rejects.toThrow();
    await expect(db.exec("UPDATE evolution_cycles SET items_per_round = 0")).rejects.toThrow();
    await expect(db.exec("UPDATE evolution_cycles SET monthly_budget_usd = 0")).rejects.toThrow();
  });

  it("al più un giro aperto per ciclo, numero unico per ciclo", async () => {
    await db.exec("INSERT INTO evolution_rounds (cycle_id, number, status) SELECT id, 1, 'analyzing' FROM evolution_cycles");
    await expect(
      db.exec("INSERT INTO evolution_rounds (cycle_id, number, status) SELECT id, 2, 'implementing' FROM evolution_cycles"),
    ).rejects.toThrow(/evolution_rounds_one_open/);
    // chiuso il primo, se ne può aprire un altro; ma non ripetere il numero
    await db.exec("UPDATE evolution_rounds SET status = 'done'");
    await expect(db.exec("INSERT INTO evolution_rounds (cycle_id, number, status) SELECT id, 1, 'analyzing' FROM evolution_cycles")).rejects.toThrow();
    await db.exec("INSERT INTO evolution_rounds (cycle_id, number, status) SELECT id, 2, 'analyzing' FROM evolution_cycles");
    const r = await db.query<any>("SELECT item_ids FROM evolution_rounds WHERE number = 2");
    expect(r.rows).toEqual([{ item_ids: [] }]);
  });

  it("FK: SET NULL sull'analisi del giro e sul giro dell'analisi", async () => {
    await db.exec(`
      UPDATE evolution_rounds SET analysis_id = (SELECT id FROM analyses LIMIT 1) WHERE number = 2;
      UPDATE analyses SET evolution_round_id = (SELECT id FROM evolution_rounds WHERE number = 2), mode = 'evolution';
    `);
    await db.exec("DELETE FROM evolution_rounds WHERE number = 1");
    await db.exec("DELETE FROM analysis_items");
    // eliminando il giro l'analisi perde il collegamento
    await db.exec("UPDATE evolution_rounds SET status = 'done' WHERE number = 2");
    await db.exec("DELETE FROM evolution_rounds WHERE number = 2");
    const a = await db.query<any>("SELECT mode, evolution_round_id FROM analyses");
    expect(a.rows).toEqual([{ mode: "evolution", evolution_round_id: null }]);
  });

  it("eliminare l'App elimina ciclo e giri", async () => {
    await db.exec("INSERT INTO evolution_rounds (cycle_id, number, status) SELECT id, 9, 'done' FROM evolution_cycles");
    await db.exec("DELETE FROM apps");
    const c = await db.query<any>(
      "SELECT (SELECT count(*) FROM evolution_cycles)::int AS c, (SELECT count(*) FROM evolution_rounds)::int AS r",
    );
    expect(c.rows[0]).toEqual({ c: 0, r: 0 });
  });
});

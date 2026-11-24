import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCRIPT = "../../../docs/migrations/2026-11-24-flotta-agenti.sql";

describe("migrazione 2026-11-24-flotta-agenti", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema attuale senza la tabella nuova: lo script si applica due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec("DROP TABLE IF EXISTS fleet_policy;");
    await db.exec("INSERT INTO users (email) VALUES ('ivan@example.com')");
    await db.exec(read(SCRIPT));
    await db.exec(read(SCRIPT));
  });

  afterAll(async () => {
    await db.close();
  });

  it("salva la riga unica con i valori predefiniti", async () => {
    await db.exec("INSERT INTO fleet_policy DEFAULT VALUES");
    const r = await db.query<any>("SELECT id, paused, max_running_runs, max_running_per_agent FROM fleet_policy");
    expect(r.rows).toEqual([{ id: 1, paused: false, max_running_runs: 6, max_running_per_agent: 2 }]);
  });

  it("ammette una sola riga e limiti nell'intervallo", async () => {
    await expect(db.exec("INSERT INTO fleet_policy (id) VALUES (2)")).rejects.toThrow();
    await expect(db.exec("UPDATE fleet_policy SET max_running_runs = 21")).rejects.toThrow();
    await expect(db.exec("UPDATE fleet_policy SET max_running_per_agent = 0")).rejects.toThrow();
  });

  it("eliminando l'utente la pausa resta senza autore", async () => {
    await db.exec("UPDATE fleet_policy SET paused = true, paused_by = (SELECT id FROM users LIMIT 1)");
    await db.exec("DELETE FROM users");
    const r = await db.query<any>("SELECT paused, paused_by FROM fleet_policy");
    expect(r.rows[0]).toEqual({ paused: true, paused_by: null });
  });
});

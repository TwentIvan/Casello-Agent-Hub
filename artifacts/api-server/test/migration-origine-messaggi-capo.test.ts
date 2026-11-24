import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCRIPT = "../../../docs/migrations/2026-11-24-origine-messaggi-capo.sql";

describe("migrazione 2026-11-24-origine-messaggi-capo", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema attuale senza la colonna nuova: lo script si applica due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec('ALTER TABLE team_events DROP COLUMN IF EXISTS turn_id');
    await db.exec(read(SCRIPT));
    await db.exec(read(SCRIPT));
    await db.exec("INSERT INTO apps (name, slug, base_url) VALUES ('A', 'a', 'https://a.example.com')");
    await db.exec("INSERT INTO team_instances (name, ref_app_id, ref_type, ref_id, ref_title, roles) VALUES ('S', 1, 'wi', '1', 'wi · 1', '[]')");
    await db.exec("INSERT INTO team_turns (instance_id) VALUES (1)");
  });

  afterAll(async () => {
    await db.close();
  });

  it("l'evento ricorda il turno; eliminando il turno resta senza", async () => {
    await db.exec("INSERT INTO team_events (instance_id, type, turn_id, bulletin) VALUES (1, 'risposta_capo', 1, 'ok')");
    expect((await db.query<any>("SELECT turn_id FROM team_events")).rows).toEqual([{ turn_id: 1 }]);
    await db.exec("DELETE FROM team_turns");
    expect((await db.query<any>("SELECT turn_id FROM team_events")).rows).toEqual([{ turn_id: null }]);
  });
});

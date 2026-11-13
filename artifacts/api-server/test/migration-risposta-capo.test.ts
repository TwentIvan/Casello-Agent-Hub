import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-risposta-capo", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema con il tipo di evento senza `risposta_capo`; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-risposta-capo.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-risposta-capo.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("aggiunge risposta_capo a team_event_type, in fondo", async () => {
    const e = await db.query<{ v: string }>("SELECT unnest(enum_range(NULL::team_event_type))::text AS v");
    expect(e.rows.map((r) => r.v).at(-1)).toBe("risposta_capo");
    expect(e.rows.filter((r) => r.v === "risposta_capo")).toHaveLength(1);
  });
});

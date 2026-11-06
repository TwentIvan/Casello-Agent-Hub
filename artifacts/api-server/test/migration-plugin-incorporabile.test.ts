import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-plugin-incorporabile", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema di produzione dopo il connettore OAuth; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-cartelle.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-connettore-oauth.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-plugin-incorporabile.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-plugin-incorporabile.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("aggiunge embed a oauth_client_kind", async () => {
    await db.exec(
      "INSERT INTO oauth_clients (client_id, kind, name, redirect_uris) VALUES ('embed:https://h.example', 'embed', 'H', '[]')",
    );
    const e = await db.query<any>("SELECT unnest(enum_range(NULL::oauth_client_kind))::text AS v");
    expect(e.rows.map((r) => r.v)).toEqual(["dcr", "metadata", "embed"]);
  });
});

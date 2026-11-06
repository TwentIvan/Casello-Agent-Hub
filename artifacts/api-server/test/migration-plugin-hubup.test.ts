import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-plugin-hubup", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema di produzione dopo il connettore OAuth; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-cartelle.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-connettore-oauth.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-plugin-hubup.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-plugin-hubup.sql"));
  });

  afterAll(async () => {
    await db.close();
  });

  it("aggiunge il valore plugin all'enum e la colonna alle app", async () => {
    const e = await db.query<any>(
      "SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'oauth_client_kind' ORDER BY e.enumsortorder",
    );
    expect(e.rows.map((r) => r.enumlabel)).toEqual(["dcr", "metadata", "plugin"]);
    const c = await db.query<any>(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'apps' AND column_name = 'plugin_url_template'",
    );
    expect(c.rows).toEqual([{ data_type: "text" }]);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCRIPT = "../../../docs/migrations/2026-11-22-nuova-app-da-zero.sql";

const insert = (slug: string, repo: string, status = "pending") =>
  `INSERT INTO app_bootstraps (user_id, slug, name, domain, repo, installation_id, brief, status)
   SELECT id, '${slug}', 'Nome', '${slug}.example.com', '${repo}', 1, 'brief', '${status}' FROM users LIMIT 1`;

describe("migrazione 2026-11-22-nuova-app-da-zero", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema attuale senza la tabella nuova: lo script si applica due volte
    db = new PGlite();
    await db.exec(read("../../../docs/schema-casello.sql"));
    await db.exec("DROP TABLE IF EXISTS app_bootstraps; DROP TYPE IF EXISTS app_bootstrap_status;");
    await db.exec("INSERT INTO users (email) VALUES ('ivan@example.com')");
    await db.exec(read(SCRIPT));
    await db.exec(read(SCRIPT));
  });

  afterAll(async () => {
    await db.close();
  });

  it("aggiunge app_bootstrap a pending_action_kind", async () => {
    const r = await db.query<any>(
      "SELECT 1 AS ok FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'pending_action_kind' AND e.enumlabel = 'app_bootstrap'",
    );
    expect(r.rows).toHaveLength(1);
  });

  it("crea la tabella con i default", async () => {
    await db.exec(insert("uno", "o/uno"));
    const r = await db.query<any>("SELECT status, steps, checklist FROM app_bootstraps WHERE slug = 'uno'");
    expect(r.rows).toEqual([{ status: "pending", steps: [], checklist: {} }]);
  });

  it("una seconda riga aperta con lo stesso slug viola l'indice unico", async () => {
    await expect(db.exec(insert("uno", "o/altro"))).rejects.toThrow(/app_bootstraps_slug_open_uidx/);
  });

  it("una seconda riga aperta con lo stesso repo viola l'indice unico", async () => {
    await expect(db.exec(insert("due", "o/uno"))).rejects.toThrow(/app_bootstraps_repo_open_uidx/);
  });

  it("con la prima riga fallita la seconda si inserisce", async () => {
    await db.exec("UPDATE app_bootstraps SET status = 'failed' WHERE slug = 'uno'");
    await db.exec(insert("uno", "o/uno"));
    const r = await db.query<any>("SELECT count(*)::int AS n FROM app_bootstraps WHERE slug = 'uno'");
    expect(r.rows[0].n).toBe(2);
  });
});

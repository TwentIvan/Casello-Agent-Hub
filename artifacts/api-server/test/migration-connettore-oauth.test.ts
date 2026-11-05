import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("migrazione 2026-11-connettore-oauth", () => {
  let db: PGlite;

  beforeAll(async () => {
    // Schema di produzione dopo il nodo locale e le cartelle; lo script si applica due volte
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-locale.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-nodo-cartelle.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-connettore-oauth.sql"));
    await db.exec(read("../../../docs/migrations/2026-11-connettore-oauth.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('a@example.com');
      INSERT INTO oauth_clients (client_id, kind, name, redirect_uris)
        VALUES ('c1', 'dcr', 'Claude', '["https://claude.ai/api/mcp/auth_callback"]');
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  it("crea le quattro tabelle e gli enum", async () => {
    const t = await db.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'oauth_%' ORDER BY table_name",
    );
    expect(t.rows.map((r) => r.table_name)).toEqual(["oauth_clients", "oauth_codes", "oauth_grants", "oauth_tokens"]);
    const e = await db.query<any>(
      "SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname LIKE 'oauth_%' ORDER BY t.typname, e.enumsortorder",
    );
    expect(e.rows.map((r) => `${r.typname}:${r.enumlabel}`)).toEqual([
      "oauth_client_kind:dcr",
      "oauth_client_kind:metadata",
      "oauth_token_kind:access",
      "oauth_token_kind:refresh",
    ]);
  });

  it("un solo collegamento attivo per utente e client", async () => {
    const ins = `INSERT INTO oauth_grants (user_id, client_id, scopes) SELECT u.id, c.id, '["mcp","api:write"]' FROM users u, oauth_clients c`;
    await db.exec(ins);
    await expect(db.exec(ins)).rejects.toThrow(/oauth_grants_active_unique/);
    await db.exec("UPDATE oauth_grants SET revoked_at = now()");
    await db.exec(ins);
    const r = await db.query<any>("SELECT count(*)::int AS n FROM oauth_grants");
    expect(r.rows[0].n).toBe(2);
  });

  it("eliminare un utente elimina collegamenti, codici e token", async () => {
    await db.exec(`
      INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at)
        SELECT 'h1', id, 'https://claude.ai/api/mcp/auth_callback', 'x', now() FROM oauth_grants LIMIT 1;
      INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at)
        SELECT 't1', id, 'access', now() FROM oauth_grants LIMIT 1;
      DELETE FROM users;
    `);
    for (const t of ["oauth_grants", "oauth_codes", "oauth_tokens"]) {
      const r = await db.query<any>(`SELECT count(*)::int AS n FROM ${t}`);
      expect(r.rows[0].n).toBe(0);
    }
    const c = await db.query<any>("SELECT count(*)::int AS n FROM oauth_clients");
    expect(c.rows[0].n).toBe(1);
  });
});

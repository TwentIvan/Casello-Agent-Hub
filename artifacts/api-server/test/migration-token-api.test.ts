import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SQL = "../../../docs/migrations/2026-10-token-api.sql";

describe("migrazione 2026-10-token-api", () => {
  let db: PGlite;

  beforeAll(async () => {
    // DB proprio: parte dallo schema precedente, con un token già presente
    db = new PGlite();
    await db.exec(read("./fixtures/schema-pre-token-api.sql"));
    await db.exec(`
      INSERT INTO users (email) VALUES ('ivan@example.com');
      INSERT INTO api_tokens (user_id, token_hash, name, expires_at)
        SELECT id, 'hash', 'Mac', now() + interval '1 day' FROM users;
    `);
    await db.exec(read(SQL));
  });

  afterAll(async () => {
    await db.close();
  });

  it("i token esistenti diventano {mcp}", async () => {
    expect((await db.query<any>("SELECT scopes FROM api_tokens")).rows).toEqual([{ scopes: ["mcp"] }]);
  });

  it("è idempotente", async () => {
    await db.exec("UPDATE api_tokens SET scopes = '{api:read,api:write}'");
    await db.exec(read(SQL));
    await db.exec(read(SQL));
    expect((await db.query<any>("SELECT scopes FROM api_tokens")).rows).toEqual([{ scopes: ["api:read", "api:write"] }]);
    expect(
      (await db.query<any>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'api_tokens' AND column_name = 'scopes'")).rows[0].n,
    ).toBe(1);
  });
});

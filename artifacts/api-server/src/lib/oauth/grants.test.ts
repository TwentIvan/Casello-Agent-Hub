import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, oauthClientsTable, oauthCodesTable, oauthGrantsTable, oauthTokensTable, pool, usersTable } from "@workspace/db";
import { listGrants, revokeGrant, sweepOAuth } from "./grants";

const DAY = 24 * 3600 * 1000;
const now = new Date("2026-11-05T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

let userId: number;
let otherId: number;

async function client(name: string, over: Partial<typeof oauthClientsTable.$inferInsert> = {}) {
  const [c] = await db
    .insert(oauthClientsTable)
    .values({ clientId: `c-${name}`, kind: "dcr", name, redirectUris: ["https://claude.ai/api/mcp/auth_callback"], ...over })
    .returning();
  return c!;
}
async function grant(uid: number, clientRowId: number, over: Partial<typeof oauthGrantsTable.$inferInsert> = {}) {
  const [g] = await db.insert(oauthGrantsTable).values({ userId: uid, clientRowId, scopes: ["mcp", "api:write"], ...over }).returning();
  return g!;
}

beforeEach(async () => {
  await pool.query("TRUNCATE oauth_clients, users RESTART IDENTITY CASCADE");
  const [a] = await db.insert(usersTable).values({ email: "a@example.test" }).returning();
  const [b] = await db.insert(usersTable).values({ email: "b@example.test" }).returning();
  userId = a!.id;
  otherId = b!.id;
});
afterAll(async () => {
  await pool.query("TRUNCATE oauth_clients, users RESTART IDENTITY CASCADE");
});

describe("collegamenti OAuth", () => {
  it("elenca i collegamenti attivi dell'utente, non quelli revocati né altrui", async () => {
    const c1 = await client("Claude", { redirectUris: ["https://claude.ai/api/mcp/auth_callback"] });
    const c2 = await client("Altro", { redirectUris: ["http://localhost:4000/callback"] });
    const old = await grant(userId, c1.id, { createdAt: ago(3 * DAY) });
    const recent = await grant(userId, c2.id, { createdAt: ago(DAY), scopes: ["mcp"], lastUsedAt: ago(1000) });
    await grant(userId, c1.id, { revokedAt: ago(1000) });
    await grant(otherId, c1.id);
    const list = await listGrants(userId);
    expect(list.map((g) => g.id)).toEqual([recent.id, old.id]);
    expect(list[0]).toMatchObject({ clientName: "Altro", redirectHost: "localhost:4000", canDecide: false });
    expect(list[0]!.lastUsedAt).toBeInstanceOf(Date);
    expect(list[1]).toMatchObject({ clientName: "Claude", redirectHost: "claude.ai", canDecide: true, lastUsedAt: null });
  });

  it("revokeGrant: una volta sola, non quelli altrui", async () => {
    const c = await client("Claude");
    const g = await grant(userId, c.id);
    expect(await revokeGrant(otherId, g.id)).toBe(false);
    expect(await revokeGrant(userId, g.id)).toBe(true);
    expect(await revokeGrant(userId, g.id)).toBe(false);
    expect(await listGrants(userId)).toEqual([]);
  });

  it("sweep: toglie codici e token scaduti da oltre un giorno, collegamenti revocati da oltre 30 giorni, client inutilizzati da oltre 24 h; tiene il resto", async () => {
    const used = await client("Usato");
    const keepClient = await client("Recente", { createdAt: ago(3600 * 1000) });
    await client("Vecchio", { createdAt: ago(2 * DAY) }); // senza collegamenti: via
    const live = await grant(userId, used.id);
    const revOld = await grant(otherId, used.id, { revokedAt: ago(31 * DAY) });
    const revNew = await grant(userId, keepClient.id, { revokedAt: ago(5 * DAY) });
    const code = (hash: string, exp: Date) => ({ codeHash: hash, grantId: live.id, redirectUri: "x", codeChallenge: "y", expiresAt: exp });
    await db.insert(oauthCodesTable).values([code("c-old", ago(2 * DAY)), code("c-recent", ago(3600 * 1000)), code("c-future", new Date(now.getTime() + 1000))]);
    const tok = (hash: string, exp: Date) => ({ tokenHash: hash, grantId: live.id, kind: "access" as const, expiresAt: exp });
    await db.insert(oauthTokensTable).values([tok("t-old", ago(2 * DAY)), tok("t-recent", ago(3600 * 1000)), tok("t-future", new Date(now.getTime() + 1000))]);

    await sweepOAuth(now);

    const hashes = async (t: string, col: string) => (await pool.query(`SELECT ${col} AS h FROM ${t} ORDER BY ${col}`)).rows.map((r) => (r as { h: string }).h);
    expect(await hashes("oauth_codes", "code_hash")).toEqual(["c-future", "c-recent"]);
    expect(await hashes("oauth_tokens", "token_hash")).toEqual(["t-future", "t-recent"]);
    const grantIds = (await pool.query("SELECT id FROM oauth_grants ORDER BY id")).rows.map((r) => (r as { id: number }).id);
    expect(grantIds).toEqual([live.id, revNew.id]);
    expect(grantIds).not.toContain(revOld.id);
    expect(await hashes("oauth_clients", "name")).toEqual(["Recente", "Usato"]);
  });
});

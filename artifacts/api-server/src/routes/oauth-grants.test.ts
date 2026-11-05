import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, oauthClientsTable, oauthGrantsTable, oauthTokensTable, pool, usersTable } from "@workspace/db";
import { sha256Hex } from "../lib/oauth/authorize";

// Route «App collegate» sull'app vera, senza login (AUTH_DISABLED: utente dev@localhost).

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL"];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let base: string;
let server: http.Server;
let userId: number;
let otherId: number;
let clientRowId: number;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function req(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await realFetch(`${base}${path}`, { method, headers });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    PUBLIC_APP_URL: "https://casello.example.test",
  });
  ({ createApiToken } = await import("../lib/api-tokens"));
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE oauth_clients, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(async () => {
  await pool.query("TRUNCATE oauth_clients, users RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "dev@localhost" }).returning();
  const [o] = await db.insert(usersTable).values({ email: "altro@example.test" }).returning();
  userId = u!.id;
  otherId = o!.id;
  const [c] = await db
    .insert(oauthClientsTable)
    .values({ clientId: "c1", kind: "dcr", name: "Claude", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] })
    .returning();
  clientRowId = c!.id;
});

async function grant(uid: number, over: Partial<typeof oauthGrantsTable.$inferInsert> = {}) {
  const [g] = await db.insert(oauthGrantsTable).values({ userId: uid, clientRowId, scopes: ["mcp", "api:write"], ...over }).returning();
  return g!;
}

describe("/api/account/oauth-grants", () => {
  it("elenca i collegamenti attivi dell'utente, non quelli revocati né altrui", async () => {
    const mine = await grant(userId);
    await grant(userId, { revokedAt: new Date() });
    await grant(otherId);
    const res = await req("GET", "/api/account/oauth-grants");
    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(1);
    expect(res.json[0]).toMatchObject({ id: mine.id, clientName: "Claude", redirectHost: "claude.ai", canDecide: true, lastUsedAt: null });
    expect(typeof res.json[0].createdAt).toBe("string");
  });

  it("DELETE revoca: 204, poi il cao_ → 401 su /mcp; altrui o già revocato → 404", async () => {
    const g = await grant(userId);
    const access = "cao_prova-token";
    await db.insert(oauthTokensTable).values({ tokenHash: sha256Hex(access), grantId: g.id, kind: "access", expiresAt: new Date(Date.now() + 3600_000) });
    const mcp = () => realFetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect((await mcp()).status).not.toBe(401);

    expect((await req("DELETE", `/api/account/oauth-grants/${g.id}`)).status).toBe(204);
    expect((await mcp()).status).toBe(401);
    const again = await req("DELETE", `/api/account/oauth-grants/${g.id}`);
    expect(again.status).toBe(404);
    expect(again.json.error).toBe("collegamento non trovato");

    const theirs = await grant(otherId);
    expect((await req("DELETE", `/api/account/oauth-grants/${theirs.id}`)).status).toBe(404);
  });

  it("con un token personale → 403", async () => {
    const g = await grant(userId);
    const { token } = await createApiToken(userId, "Prova", 30, ["api:read", "api:write"]);
    const auth = { authorization: `Bearer ${token}` };
    expect((await req("GET", "/api/account/oauth-grants", auth)).status).toBe(403);
    expect((await req("DELETE", `/api/account/oauth-grants/${g.id}`, auth)).status).toBe(403);
  });
});

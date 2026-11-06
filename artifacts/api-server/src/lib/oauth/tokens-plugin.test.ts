import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, oauthGrantsTable, pool, usersTable } from "@workspace/db";
import { approve, sha256Hex, type AuthorizeParams } from "./authorize";
import { sweepOAuth } from "./grants";
import { authorizationServerMetadata } from "./metadata";
import { OAuthError } from "./errors";
import { ensurePluginClientRow, pluginClient } from "./plugins";
import { exchangeCode, refreshTokens, verifyAccessToken, verifyPluginAccessToken } from "./tokens";

// Token endpoint per i client plugin (The Hub Up): segreto del client, token cap_, ambiti api.

const CB = "https://hubup.example.test/botcave/callback";
const SECRET = "segreto-del-plugin";
const VERIFIER = "v".repeat(60);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const CONFIG = JSON.stringify([
  { clientId: "hubup", name: "The Hub Up", redirectUri: CB, secretSha256: createHash("sha256").update(SECRET).digest("hex") },
]);

let userId: number;
let clientRowId: number;
const saved = { allowed: process.env["ALLOWED_EMAILS"], plugins: process.env["OAUTH_PLUGIN_CLIENTS"] };

async function reset() {
  await pool.query("TRUNCATE oauth_clients, users RESTART IDENTITY CASCADE");
}

beforeAll(() => {
  process.env["ALLOWED_EMAILS"] = "plug@example.test";
});
afterAll(async () => {
  await reset();
  if (saved.allowed === undefined) delete process.env["ALLOWED_EMAILS"];
  else process.env["ALLOWED_EMAILS"] = saved.allowed;
  if (saved.plugins === undefined) delete process.env["OAUTH_PLUGIN_CLIENTS"];
  else process.env["OAUTH_PLUGIN_CLIENTS"] = saved.plugins;
});
beforeEach(async () => {
  await reset();
  process.env["OAUTH_PLUGIN_CLIENTS"] = CONFIG;
  const [u] = await db.insert(usersTable).values({ email: "plug@example.test" }).returning({ id: usersTable.id });
  userId = u!.id;
  clientRowId = (await ensurePluginClientRow(pluginClient("hubup")!)).id;
});

function params(): AuthorizeParams {
  return { clientId: "hubup", clientRowId, clientName: "The Hub Up", redirectUri: CB, codeChallenge: CHALLENGE, state: "s", kind: "plugin" };
}
async function getCode(): Promise<string> {
  return new URL(await approve(userId, params())).searchParams.get("code")!;
}
function form(code: string, over: Record<string, unknown> = {}) {
  return { grant_type: "authorization_code", code, redirect_uri: CB, client_id: "hubup", client_secret: SECRET, code_verifier: VERIFIER, ...over };
}
function rform(refresh: string, over: Record<string, unknown> = {}) {
  return { grant_type: "refresh_token", refresh_token: refresh, client_id: "hubup", client_secret: SECRET, ...over };
}
async function rejects(p: Promise<unknown>, code: string, status?: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OAuthError);
  expect((err as OAuthError).code).toBe(code);
  if (status !== undefined) expect((err as OAuthError).status).toBe(status);
}

describe("scambio del codice di un plugin", () => {
  it("segreto giusto → cap_/car_, scope api:read api:write", async () => {
    const out = await exchangeCode(form(await getCode()));
    expect(out.access_token).toMatch(/^cap_[A-Za-z0-9_-]{43}$/);
    expect(out.refresh_token).toMatch(/^car_[A-Za-z0-9_-]{43}$/);
    expect(out).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "api:read api:write" });
  });

  it("segreto mancante o sbagliato → invalid_client 401, il codice resta scambiabile", async () => {
    const code = await getCode();
    await rejects(exchangeCode(form(code, { client_secret: undefined })), "invalid_client", 401);
    await rejects(exchangeCode(form(code, { client_secret: "sbagliato" })), "invalid_client", 401);
    const out = await exchangeCode(form(code));
    expect(out.access_token.startsWith("cap_")).toBe(true);
  });

  it("plugin tolto dalla configurazione → invalid_client 401", async () => {
    const code = await getCode();
    process.env["OAUTH_PLUGIN_CLIENTS"] = "[]";
    await rejects(exchangeCode(form(code)), "invalid_client", 401);
  });
});

describe("rinnovo di un plugin", () => {
  it("segreto sbagliato → invalid_client, poi il segreto giusto rinnova (token intatto)", async () => {
    const first = await exchangeCode(form(await getCode()));
    await rejects(refreshTokens(rform(first.refresh_token, { client_secret: "no" })), "invalid_client", 401);
    await rejects(refreshTokens(rform(first.refresh_token, { client_secret: undefined })), "invalid_client", 401);
    const second = await refreshTokens(rform(first.refresh_token));
    expect(second.access_token).toMatch(/^cap_/);
  });

  it("rinnovo riuscito → coppia cap_/car_; il vecchio car_ riusato dopo 61 s revoca il collegamento", async () => {
    const first = await exchangeCode(form(await getCode()));
    const second = await refreshTokens(rform(first.refresh_token));
    expect(second.access_token).toMatch(/^cap_/);
    expect(second.refresh_token).toMatch(/^car_/);
    expect(second.scope).toBe("api:read api:write");
    await pool.query("UPDATE oauth_tokens SET used_at = timezone('utc', now()) - interval '61 seconds' WHERE token_hash = $1", [
      sha256Hex(first.refresh_token),
    ]);
    await rejects(refreshTokens(rform(first.refresh_token)), "invalid_grant");
    const [grant] = await db.select().from(oauthGrantsTable);
    expect(grant!.revokedAt).not.toBeNull();
  });

  it("plugin tolto dalla configurazione → invalid_client; verifyPluginAccessToken → null", async () => {
    const first = await exchangeCode(form(await getCode()));
    process.env["OAUTH_PLUGIN_CLIENTS"] = "[]";
    await rejects(refreshTokens(rform(first.refresh_token)), "invalid_client", 401);
    expect(await verifyPluginAccessToken(first.access_token)).toBeNull();
  });
});

describe("verifica dei token", () => {
  it("verifyPluginAccessToken: valido → utente e ambiti; cao_ e revocato → null", async () => {
    const out = await exchangeCode(form(await getCode()));
    expect(await verifyPluginAccessToken(out.access_token)).toMatchObject({ userId, scopes: ["api:read", "api:write"] });
    expect(await verifyPluginAccessToken("cao_" + out.access_token.slice(4))).toBeNull();
    await db.update(oauthGrantsTable).set({ revokedAt: new Date() });
    expect(await verifyPluginAccessToken(out.access_token)).toBeNull();
  });

  it("verifyAccessToken (connettore) rifiuta un cap_", async () => {
    const out = await exchangeCode(form(await getCode()));
    expect(await verifyAccessToken(out.access_token)).toBeNull();
  });
});

describe("pulizia e metadati", () => {
  it("sweepOAuth non cancella un client plugin senza collegamenti", async () => {
    await pool.query("UPDATE oauth_clients SET created_at = timezone('utc', now()) - interval '2 days'");
    await sweepOAuth();
    const rows = await pool.query("SELECT 1 FROM oauth_clients WHERE client_id = 'hubup'");
    expect(rows.rowCount).toBe(1);
  });

  it("i metadati dichiarano client_secret_post e gli ambiti api", () => {
    const m = authorizationServerMetadata();
    expect(m.token_endpoint_auth_methods_supported).toEqual(["none", "client_secret_post"]);
    expect(m.scopes_supported).toEqual(["mcp", "api:read", "api:write"]);
  });
});

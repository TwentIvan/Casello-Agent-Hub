import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, oauthGrantsTable, oauthTokensTable, pool, usersTable } from "@workspace/db";
import { approve, sha256Hex, type AuthorizeParams } from "./authorize";
import { registerClient } from "./clients";
import { oauthBase } from "./config";
import { OAuthError } from "./errors";
import { exchangeCode, refreshTokens, verifyAccessToken } from "./tokens";

const CB = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(60);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let userId: number;
let clientId: string;
let clientRowId: number;
const saved = process.env["ALLOWED_EMAILS"];

async function reset() {
  await pool.query("TRUNCATE oauth_clients, users RESTART IDENTITY CASCADE");
}

beforeAll(async () => {
  process.env["ALLOWED_EMAILS"] = "tok@example.test";
});
afterAll(async () => {
  await reset();
  if (saved === undefined) delete process.env["ALLOWED_EMAILS"];
  else process.env["ALLOWED_EMAILS"] = saved;
});
beforeEach(async () => {
  await reset();
  const [u] = await db.insert(usersTable).values({ email: "tok@example.test" }).returning({ id: usersTable.id });
  userId = u!.id;
  const reg = await registerClient({ redirect_uris: [CB], client_name: "Claude" });
  clientId = (reg.body as { client_id: string }).client_id;
  const [row] = await pool.query("SELECT id FROM oauth_clients WHERE client_id = $1", [clientId]).then((r) => r.rows);
  clientRowId = (row as { id: number }).id;
});

function params(over: Partial<AuthorizeParams> = {}): AuthorizeParams {
  return { clientId, clientRowId, clientName: "Claude", redirectUri: CB, codeChallenge: CHALLENGE, state: "s", ...over };
}
async function getCode(): Promise<string> {
  const url = new URL(await approve(userId, params()));
  return url.searchParams.get("code")!;
}
function form(code: string, over: Record<string, unknown> = {}) {
  return { grant_type: "authorization_code", code, redirect_uri: CB, client_id: clientId, code_verifier: VERIFIER, ...over };
}
async function rejects(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OAuthError);
  expect((err as OAuthError).code).toBe(code);
}

describe("scambio del codice", () => {
  it("codice + verifier giusto → token cao_/car_, expires_in 3600, scope mcp", async () => {
    const out = await exchangeCode(form(await getCode()));
    expect(out.access_token).toMatch(/^cao_[A-Za-z0-9_-]{43}$/);
    expect(out.refresh_token).toMatch(/^car_[A-Za-z0-9_-]{43}$/);
    expect(out).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp" });
    const rows = await db.select().from(oauthTokensTable);
    expect(rows.map((r) => r.kind).sort()).toEqual(["access", "refresh"]);
    expect(rows.some((r) => r.tokenHash === out.access_token)).toBe(false);
    expect(rows.some((r) => r.tokenHash === sha256Hex(out.refresh_token))).toBe(true);
  });

  it("verifier sbagliato, codice scaduto, altro client o altro redirect → invalid_grant", async () => {
    await rejects(exchangeCode(form(await getCode(), { code_verifier: "w".repeat(60) })), "invalid_grant");
    const expired = await getCode();
    await pool.query("UPDATE oauth_codes SET expires_at = timezone('utc', now()) - interval '1 minute'");
    await rejects(exchangeCode(form(expired)), "invalid_grant");
    const other = await registerClient({ redirect_uris: [CB], client_name: "Altro" });
    const otherId = (other.body as { client_id: string }).client_id;
    await rejects(exchangeCode(form(await getCode(), { client_id: otherId })), "invalid_grant");
    await rejects(exchangeCode(form(await getCode(), { redirect_uri: "http://localhost:1/callback" })), "invalid_grant");
    await rejects(exchangeCode(form("sconosciuto".padEnd(43, "x"))), "invalid_grant");
  });

  it("client sconosciuto → invalid_client (401); parametri mancanti → invalid_request; resource errata → invalid_target", async () => {
    const code = await getCode();
    const err = (await exchangeCode(form(code, { client_id: "cac_nope" })).catch((e: unknown) => e)) as OAuthError;
    expect(err.code).toBe("invalid_client");
    expect(err.status).toBe(401);
    await rejects(exchangeCode(form(code, { code_verifier: undefined })), "invalid_request");
    await rejects(exchangeCode(form(code, { resource: "https://altro.example/mcp" })), "invalid_target");
    expect((await exchangeCode(form(code, { resource: oauthBase().resource }))).token_type).toBe("Bearer");
  });

  it("due scambi concorrenti dello stesso codice: uno solo riesce", async () => {
    const code = await getCode();
    const results = await Promise.allSettled([exchangeCode(form(code)), exchangeCode(form(code))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(oauthTokensTable)).toHaveLength(2);
  });

  it("un collegamento revocato non scambia il codice", async () => {
    const code = await getCode();
    await db.update(oauthGrantsTable).set({ revokedAt: new Date() });
    await rejects(exchangeCode(form(code)), "invalid_grant");
  });
});

describe("rinnovo", () => {
  it("rinnovo: coppia nuova, il car_ vecchio non vale più", async () => {
    const first = await exchangeCode(form(await getCode()));
    const second = await refreshTokens({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId });
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await verifyAccessToken(second.access_token)).toMatchObject({ userId, scopes: ["mcp", "api:write"] });
    await rejects(refreshTokens({ refresh_token: first.refresh_token, client_id: clientId }), "invalid_grant");
  });

  it("car_ riusato → invalid_grant e collegamento revocato: anche il cao_ nuovo non vale", async () => {
    const first = await exchangeCode(form(await getCode()));
    const second = await refreshTokens({ refresh_token: first.refresh_token, client_id: clientId });
    await rejects(refreshTokens({ refresh_token: first.refresh_token, client_id: clientId }), "invalid_grant");
    const [grant] = await db.select().from(oauthGrantsTable);
    expect(grant!.revokedAt).not.toBeNull();
    expect(await verifyAccessToken(second.access_token)).toBeNull();
    await rejects(refreshTokens({ refresh_token: second.refresh_token, client_id: clientId }), "invalid_grant");
  });

  it("rinnovo scaduto, di un altro client o sconosciuto → invalid_grant", async () => {
    const first = await exchangeCode(form(await getCode()));
    const other = await registerClient({ redirect_uris: [CB], client_name: "Altro" });
    const otherId = (other.body as { client_id: string }).client_id;
    await rejects(refreshTokens({ refresh_token: first.refresh_token, client_id: otherId }), "invalid_grant");
    await rejects(refreshTokens({ refresh_token: "car_nonesiste", client_id: clientId }), "invalid_grant");
    await rejects(refreshTokens({ refresh_token: first.access_token, client_id: clientId }), "invalid_grant");
    await pool.query("UPDATE oauth_tokens SET expires_at = timezone('utc', now()) - interval '1 minute'");
    await rejects(refreshTokens({ refresh_token: first.refresh_token, client_id: clientId }), "invalid_grant");
  });
});

describe("verifyAccessToken", () => {
  it("scaduto, revocato o utente fuori da ALLOWED_EMAILS → null", async () => {
    const t = await exchangeCode(form(await getCode()));
    expect(await verifyAccessToken(t.access_token)).toMatchObject({ userId });
    expect(await verifyAccessToken("cao_sconosciuto")).toBeNull();
    expect(await verifyAccessToken(t.refresh_token)).toBeNull();

    process.env["ALLOWED_EMAILS"] = "altro@example.test";
    expect(await verifyAccessToken(t.access_token)).toBeNull();
    process.env["ALLOWED_EMAILS"] = "tok@example.test";
    expect(await verifyAccessToken(t.access_token)).not.toBeNull();

    await pool.query("UPDATE oauth_tokens SET expires_at = timezone('utc', now()) - interval '1 minute' WHERE kind = 'access'");
    expect(await verifyAccessToken(t.access_token)).toBeNull();
    await pool.query("UPDATE oauth_tokens SET expires_at = timezone('utc', now()) + interval '1 hour' WHERE kind = 'access'");
    await db.update(oauthGrantsTable).set({ revokedAt: new Date() });
    expect(await verifyAccessToken(t.access_token)).toBeNull();
  });

  it("aggiorna last_used_at al massimo una volta al minuto", async () => {
    const t = await exchangeCode(form(await getCode()));
    await verifyAccessToken(t.access_token);
    const [a] = await db.select().from(oauthGrantsTable);
    expect(a!.lastUsedAt).not.toBeNull();
    await verifyAccessToken(t.access_token);
    const [b] = await db.select().from(oauthGrantsTable).where(eq(oauthGrantsTable.id, a!.id));
    expect(b!.lastUsedAt!.getTime()).toBe(a!.lastUsedAt!.getTime());
    await pool.query("UPDATE oauth_grants SET last_used_at = timezone('utc', now()) - interval '2 minutes'");
    await verifyAccessToken(t.access_token);
    const [c] = await db.select().from(oauthGrantsTable);
    expect(Date.now() - c!.lastUsedAt!.getTime()).toBeLessThan(60_000);
  });
});

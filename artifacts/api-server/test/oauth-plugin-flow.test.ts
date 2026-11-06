import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, oauthGrantsTable, usersTable } from "@workspace/db";

// Flusso completo di un plugin (The Hub Up) sull'app vera: consenso, scambio col segreto del client,
// uso del cap_ su /api, route solo-login, /mcp, rinnovo, revoca e plugin tolto dalla configurazione.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL", "OAUTH_PLUGIN_CLIENTS"];
const saved: Record<string, string | undefined> = {};
const ISSUER = "https://casello.example.test";
const CB = "https://hubup.example.test/botcave/callback";
const SECRET = "segreto";
const CONFIG = JSON.stringify([
  { clientId: "hubup", name: "The Hub Up", redirectUri: CB, secretSha256: createHash("sha256").update(SECRET).digest("hex") },
]);
const SESSION_ONLY = "operazione disponibile solo con il login";

let base: string;
let server: http.Server;
let cookie = "";

const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url");

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    PUBLIC_APP_URL: ISSUER,
  });
  const { default: app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE oauth_clients, apps, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  process.env["OAUTH_PLUGIN_CLIENTS"] = CONFIG;
  process.env["ALLOWED_EMAILS"] = "dev@localhost";
  await pool.query("TRUNCATE oauth_clients, apps, users RESTART IDENTITY CASCADE");
  await db.insert(usersTable).values({ email: "dev@localhost" });
});

type Tokens = { access: string; refresh: string };

/** Consenso con la sessione e scambio del codice col segreto del client. */
async function pluginFlow(): Promise<Tokens> {
  const verifier = randomBytes(32).toString("base64url");
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: "hubup",
    redirect_uri: CB,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
    state: "st-1",
  });
  const page = await fetch(`${base}/oauth/authorize?${qs}`, { redirect: "manual" });
  expect(page.status).toBe(200);
  cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
  const dec = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrf, decision: "allow" }).toString(),
  });
  expect(dec.status).toBe(302);
  const code = new URL(dec.headers.get("location")!).searchParams.get("code")!;
  const tok = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: "hubup", client_secret: SECRET, code_verifier: verifier }).toString(),
  });
  expect(tok.status).toBe(200);
  const json = (await tok.json()) as { access_token: string; refresh_token: string };
  return { access: json.access_token, refresh: json.refresh_token };
}

const api = (path: string, bearer: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(init.headers ?? {}) } });

describe("plugin OAuth: flusso completo", () => {
  it("metadati, consenso, scambio, /auth/me e scrittura con il cap_", async () => {
    const meta = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(meta.status).toBe(200);
    const { access } = await pluginFlow();
    expect(access.startsWith("cap_")).toBe(true);

    const me = await api("/api/auth/me", access);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { email: string; auth: { kind: string; scopes: string[] } };
    expect(body.email).toBe("dev@localhost");
    expect(body.auth.kind).toBe("token");
    expect(body.auth.scopes).toEqual(["api:read", "api:write"]);

    const created = await api("/api/apps", access, { method: "POST", body: JSON.stringify({ name: "Mister", baseUrl: "http://mister.example" }) });
    expect(created.status).toBe(201);
    expect((await api("/api/apps", access)).status).toBe(200);
  });

  it("route solo-login con il cap_: 403", async () => {
    const { access } = await pluginFlow();
    const put = await api("/api/budget", access, { method: "PUT", body: JSON.stringify({ monthlyBudgetUsd: 10 }) });
    expect(put.status).toBe(403);
    expect(((await put.json()) as { error: string }).error).toBe(SESSION_ONLY);
    const tok = await api("/api/account/tokens", access, { method: "POST", body: JSON.stringify({ name: "x" }) });
    expect(tok.status).toBe(403);
    expect(((await tok.json()) as { error: string }).error).toBe(SESSION_ONLY);
  });

  it("cap_ su /mcp → 401; cao_ su /api → 401", async () => {
    const { access } = await pluginFlow();
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${access}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    expect(mcp.status).toBe(401);

    const reg = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const cb = "https://claude.ai/api/mcp/auth_callback";
    const verifier = randomBytes(32).toString("base64url");
    const qs = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: cb, code_challenge: challengeOf(verifier), code_challenge_method: "S256", state: "s", scope: "mcp", resource: `${ISSUER}/mcp` });
    const page = await fetch(`${base}/oauth/authorize?${qs}`, { redirect: "manual" });
    const ck = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    const dec = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: ck }, body: new URLSearchParams({ csrf, decision: "allow" }).toString() });
    const code = new URL(dec.headers.get("location")!).searchParams.get("code")!;
    const t = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: cb, client_id: clientId, code_verifier: verifier }).toString() });
    const cao = ((await t.json()) as { access_token: string }).access_token;
    expect(cao.startsWith("cao_")).toBe(true);
    expect((await api("/api/apps", cao)).status).toBe(401);
  });

  it("rinnovo: il nuovo cap_ vale e il vecchio vale fino alla scadenza", async () => {
    const { access, refresh } = await pluginFlow();
    const rt = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: "hubup", client_secret: SECRET }).toString(),
    });
    expect(rt.status).toBe(200);
    const next = ((await rt.json()) as { access_token: string }).access_token;
    expect(next.startsWith("cap_")).toBe(true);
    expect((await api("/api/apps", next)).status).toBe(200);
    expect((await api("/api/apps", access)).status).toBe(200);
  });

  it("revoca del collegamento dalla console: il cap_ risponde 401", async () => {
    const { access } = await pluginFlow();
    const [grant] = await db.select().from(oauthGrantsTable);
    const del = await fetch(`${base}/api/account/oauth-grants/${grant!.id}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(204);
    expect((await api("/api/apps", access)).status).toBe(401);
  });

  it("plugin tolto dalla configurazione: il cap_ risponde 401", async () => {
    const { access } = await pluginFlow();
    expect((await api("/api/apps", access)).status).toBe(200);
    process.env["OAUTH_PLUGIN_CLIENTS"] = "[]";
    expect((await api("/api/apps", access)).status).toBe(401);
  });
});

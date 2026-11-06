import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, usersTable } from "@workspace/db";
import { ensureEmbedClients } from "../src/lib/embed/clients";

// Token `cao_` con ambito embed su /api (lettura e scrittura, ma non le route solo-login) e sessioni di Alfred; mai su /mcp.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL", "EMBED_ALLOWED_ORIGINS"];
const saved: Record<string, string | undefined> = {};
const ORIGIN = "https://hubup.fantamister.cloud";
const EMBED_CLIENT = `embed:${ORIGIN}`;
const PUBLIC = "https://casello.example.test";
const EMBED_CB = `${PUBLIC}/embed/callback`;
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

let base: string;
let server: http.Server;

const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url");

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    PUBLIC_APP_URL: PUBLIC,
    EMBED_ALLOWED_ORIGINS: ORIGIN,
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
  process.env["EMBED_ALLOWED_ORIGINS"] = ORIGIN;
  await pool.query("TRUNCATE oauth_clients, apps, users RESTART IDENTITY CASCADE");
  await db.insert(usersTable).values({ email: "dev@localhost" });
  await ensureEmbedClients();
});

async function oauthToken(clientId: string, redirectUri: string, scope: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
    state: "st-1",
    scope,
  }).toString();
  const page = await fetch(`${base}/oauth/authorize?${qs}`, { redirect: "manual" });
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
  const dec = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrf, decision: "allow" }).toString(),
  });
  const code = new URL(dec.headers.get("location")!).searchParams.get("code")!;
  const tok = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }).toString(),
  });
  return ((await tok.json()) as { access_token: string }).access_token;
}

const embedToken = () => oauthToken(EMBED_CLIENT, EMBED_CB, "embed");

async function mcpToken(): Promise<string> {
  const reg = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CB], client_name: "Claude" }),
  });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  return oauthToken(clientId, CLAUDE_CB, "mcp");
}

const call = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("token embed su /api", () => {
  it("legge e scrive", async () => {
    const t = await embedToken();
    expect((await call("GET", "/api/pending-actions", t)).status).toBe(200);
    expect((await call("POST", "/api/team-events/read", t, { ids: [] })).status).toBe(200);
  });

  it("route solo-login: 403", async () => {
    const t = await embedToken();
    const tokens = await call("GET", "/api/account/tokens", t);
    expect(tokens.status).toBe(403);
    expect(((await tokens.json()) as { error: string }).error).toBe("operazione disponibile solo con il login");
    expect((await call("PUT", "/api/budget", t, { monthlyBudgetUsd: null })).status).toBe(403);
    expect((await call("GET", "/api/account/alfred", t)).status).toBe(403);
  });

  it("sessioni di Alfred: ammesse (409 senza modello)", async () => {
    const t = await embedToken();
    const res = await call("POST", "/api/alfred/sessions", t, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("scegli il modello di Alfred in Account");
  });

  it("/mcp rifiuta il token embed", async () => {
    const t = await embedToken();
    const res = await call("POST", "/mcp", t, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
  });

  it("un cao_ del connettore (mcp) su /api: 401", async () => {
    const t = await mcpToken();
    expect((await call("GET", "/api/pending-actions", t)).status).toBe(401);
  });

  it("un token personale con ambito embed alla creazione: 400", async () => {
    const res = await fetch(`${base}/api/account/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", expiresInDays: 30, scopes: ["embed"] }),
    });
    expect(res.status).toBe(400);
  });

  it("origine tolta dalla variabile: 401 e collegamento revocato", async () => {
    const t = await embedToken();
    expect((await call("GET", "/api/pending-actions", t)).status).toBe(200);
    process.env["EMBED_ALLOWED_ORIGINS"] = "https://altra.example.test";
    const res = await call("GET", "/api/pending-actions", t);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("token non valido o scaduto");
    const { rows } = await pool.query("SELECT revoked_at FROM oauth_grants");
    expect(rows[0].revoked_at).not.toBeNull();
  });

  // Ultimo: il contatore è in memoria e la chiave (id del collegamento) si ripete dopo il TRUNCATE
  it("limite di 120 richieste al minuto per collegamento", async () => {
    const t = await embedToken();
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await call("GET", "/api/pending-actions", t)).status;
    expect(last).toBe(429);
  });
});

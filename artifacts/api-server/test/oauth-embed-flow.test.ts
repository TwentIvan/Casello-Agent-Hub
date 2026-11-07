import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, usersTable } from "@workspace/db";
import { ensureEmbedClients } from "../src/lib/embed/clients";

// Ambito `embed`: flusso OAuth del pannello incorporato (popup + PKCE) e difese; il connettore Claude non cambia.

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
  process.env["ALLOWED_EMAILS"] = "dev@localhost";
  await pool.query("TRUNCATE oauth_clients, apps, users RESTART IDENTITY CASCADE");
  await db.insert(usersTable).values({ email: "dev@localhost" });
  await ensureEmbedClients();
});

function authorizeQs(over: Record<string, string>, verifier: string): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: EMBED_CLIENT,
    redirect_uri: EMBED_CB,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
    state: "st-1",
    scope: "embed",
    ...over,
  }).toString();
}

async function registerDcr(): Promise<string> {
  const reg = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CB], client_name: "Claude" }),
  });
  return ((await reg.json()) as { client_id: string }).client_id;
}

async function embedConsent(verifier: string): Promise<{ code: string; refreshUrlLoc: URL }> {
  const page = await fetch(`${base}/oauth/authorize?${authorizeQs({}, verifier)}`, { redirect: "manual" });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const html = await page.text();
  expect(html).toContain("hubup.fantamister.cloud");
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const dec = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrf, decision: "allow" }).toString(),
  });
  expect(dec.status).toBe(302);
  const loc = new URL(dec.headers.get("location")!);
  expect(`${loc.origin}${loc.pathname}`).toBe(EMBED_CB);
  expect(loc.searchParams.get("state")).toBe("st-1");
  return { code: loc.searchParams.get("code")!, refreshUrlLoc: loc };
}

async function token(form: Record<string, string>): Promise<Response> {
  return fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

describe("OAuth: ambito embed", () => {
  it("flusso completo del client embed: consenso, codice, cao_, collegamento con ambito embed", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const { code } = await embedConsent(verifier);
    const tok = await token({ grant_type: "authorization_code", code, redirect_uri: EMBED_CB, client_id: EMBED_CLIENT, code_verifier: verifier });
    expect(tok.status).toBe(200);
    const json = (await tok.json()) as { access_token: string; scope: string };
    expect(json.access_token.startsWith("cao_")).toBe(true);
    expect(json.scope).toBe("embed");
    const { rows } = await pool.query("SELECT scopes FROM oauth_grants");
    expect(rows).toHaveLength(1);
    expect(rows[0].scopes).toEqual(["embed"]);

    const list = await fetch(`${base}/api/account/oauth-grants`);
    const grants = (await list.json()) as { redirectHost: string; canDecide: boolean }[];
    expect(grants[0]!.redirectHost).toBe("hubup.fantamister.cloud");
    // Il pannello approva e rifiuta le voci della coda: «App collegate» lo deve dire
    expect(grants[0]!.canDecide).toBe(true);
  });

  it("scope=mcp con un client embed: invalid_scope con redirect", async () => {
    const res = await fetch(`${base}/oauth/authorize?${authorizeQs({ scope: "mcp" }, randomBytes(32).toString("base64url"))}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
  });

  it("scope=embed con un client dcr: invalid_scope", async () => {
    const clientId = await registerDcr();
    const qs = authorizeQs({ client_id: clientId, redirect_uri: CLAUDE_CB, scope: "embed" }, randomBytes(32).toString("base64url"));
    const res = await fetch(`${base}/oauth/authorize?${qs}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
  });

  it("scope embed e mcp insieme: invalid_scope per entrambi i tipi", async () => {
    const res = await fetch(`${base}/oauth/authorize?${authorizeQs({ scope: "embed mcp" }, randomBytes(32).toString("base64url"))}`, { redirect: "manual" });
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
  });

  it("ritorno di Claude con un client embed: pagina d'errore", async () => {
    const res = await fetch(`${base}/oauth/authorize?${authorizeQs({ redirect_uri: CLAUDE_CB }, randomBytes(32).toString("base64url"))}`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Indirizzo di ritorno non valido.");
  });

  it("origine tolta dalla variabile: rinnovo e scambio del codice danno invalid_client e il collegamento si revoca", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const { code } = await embedConsent(verifier);
    const tok = await token({ grant_type: "authorization_code", code, redirect_uri: EMBED_CB, client_id: EMBED_CLIENT, code_verifier: verifier });
    const { refresh_token } = (await tok.json()) as { refresh_token: string };

    process.env["EMBED_ALLOWED_ORIGINS"] = "https://altra.example.test";
    const res = await token({ grant_type: "refresh_token", refresh_token, client_id: EMBED_CLIENT });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
    const { rows } = await pool.query("SELECT revoked_at FROM oauth_grants");
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it("origine tolta prima dello scambio del codice: invalid_client", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const { code } = await embedConsent(verifier);
    process.env["EMBED_ALLOWED_ORIGINS"] = "";
    const res = await token({ grant_type: "authorization_code", code, redirect_uri: EMBED_CB, client_id: EMBED_CLIENT, code_verifier: verifier });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
  });
});

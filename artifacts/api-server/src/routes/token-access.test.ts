import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { apiTokensTable, db, pool, usersTable } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../test/fake-github";
import type { TokenScope } from "../lib/api-tokens";

// Token personali su /api, sull'app completa (porta 0) con AUTH_DISABLED=true: senza header la
// richiesta passa come «sessione» di sviluppo, con l'header conta solo il token. L'utente dei token
// si crea a mano. Il logger è sostituito da un pino con la stessa redazione che scrive in memoria:
// così si verifica cosa registra davvero pino-http. GitHub è configurato (finto) prima di importare
// l'app, perché DELETE /auth/github esiste solo con GitHub attivo.
// Le tabelle si svuotano SENZA ripartire con gli id: il limite per token è in memoria per id.

const logLines = vi.hoisted(() => [] as string[]);

vi.mock("../lib/logger", async () => {
  const { default: pino } = await import("pino");
  const actual = await vi.importActual<typeof import("../lib/logger")>("../lib/logger");
  const logger = pino({ level: "trace", redact: actual.LOG_REDACT_PATHS }, { write: (line: string) => void logLines.push(line) });
  return { ...actual, logger };
});

const TOKEN_EMAIL = "token@example.com";
const MESSAGES = {
  invalid: "token non valido o scaduto",
  scope: "il token non ha l'ambito per questa operazione",
  sessionOnly: "operazione disponibile solo con il login",
};

const GITHUB_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_API_BASE",
  "GITHUB_WEB_BASE",
];
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", ...GITHUB_KEYS];
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let gh: FakeGithub;
let userId: number;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;
let revokeApiToken: typeof import("../lib/api-tokens").revokeApiToken;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, opts: { token?: string; auth?: string; body?: unknown } = {}): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.auth !== undefined) headers["authorization"] = opts.auth;
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function tokenWith(scopes: TokenScope[], days = 30): Promise<string> {
  return (await createApiToken(userId, "Script", days, scopes)).token;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  gh = await startFakeGithub();
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: TOKEN_EMAIL,
    CASELLO_SECRET_KEY: "a".repeat(64),
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
  });
  const { default: app } = await import("../app");
  ({ createApiToken, revokeApiToken } = await import("../lib/api-tokens"));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await gh.close();
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  process.env["ALLOWED_EMAILS"] = TOKEN_EMAIL;
  await pool.query("TRUNCATE users CASCADE");
  const [user] = await db.insert(usersTable).values({ email: TOKEN_EMAIL, name: "Token" }).returning();
  userId = user!.id;
});

describe("token personali su /api", () => {
  it("api:read: GET /apps 200, POST /apps 403 scope", async () => {
    const token = await tokenWith(["api:read"]);
    expect((await api("GET", "/apps", { token })).status).toBe(200);
    expect((await api("HEAD", "/apps", { token })).status).toBe(200);
    const post = await api("POST", "/apps", { token, body: { name: "Mister", baseUrl: "https://mister.example.com" } });
    expect(post.status).toBe(403);
    expect(post.json).toEqual({ error: MESSAGES.scope });
  });

  it("api:write: POST /apps 201", async () => {
    const token = await tokenWith(["api:write"]);
    const post = await api("POST", "/apps", { token, body: { name: "Mister", baseUrl: "https://mister.example.com" } });
    expect(post.status, post.text).toBe(201);
    // api:write include la lettura
    expect((await api("GET", "/apps", { token })).status).toBe(200);
  });

  it("solo mcp: GET /apps 403 scope", async () => {
    const token = await tokenWith(["mcp"]);
    const res = await api("GET", "/apps", { token });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: MESSAGES.scope });
  });

  it("token scaduto o revocato → 401 invalid; revoca efficace alla richiesta successiva", async () => {
    const expired = await tokenWith(["api:read"]);
    await db.update(apiTokensTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiTokensTable.userId, userId));
    const res = await api("GET", "/apps", { token: expired });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: MESSAGES.invalid });

    const created = await createApiToken(userId, "Revocato", 30, ["api:read"]);
    expect((await api("GET", "/apps", { token: created.token })).status).toBe(200);
    expect(await revokeApiToken(userId, created.row.id)).toBe(true);
    const after = await api("GET", "/apps", { token: created.token });
    expect(after.status).toBe(401);
    expect(after.json).toEqual({ error: MESSAGES.invalid });

    const unknown = await api("GET", "/apps", { token: "cas_sconosciuto" });
    expect(unknown.status).toBe(401);
    expect(unknown.json).toEqual({ error: MESSAGES.invalid });
  });

  it("Authorization non Bearer o Bearer senza cas_ → 401 anche con la sessione di sviluppo", async () => {
    const token = await tokenWith(["api:read"]);
    // Senza header la sessione di sviluppo basta
    expect((await api("GET", "/apps")).status).toBe(200);
    for (const auth of [`Basic ${token}`, token, "Bearer abc", "Bearer", ""]) {
      const res = await api("GET", "/apps", { auth });
      expect(res.status, JSON.stringify(auth)).toBe(401);
      expect(res.json).toEqual({ error: MESSAGES.invalid });
    }
  });

  it("utente tolto da ALLOWED_EMAILS → 401", async () => {
    const token = await tokenWith(["api:read"]);
    expect((await api("GET", "/apps", { token })).status).toBe(200);
    process.env["ALLOWED_EMAILS"] = "altro@example.com";
    const res = await api("GET", "/apps", { token });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: MESSAGES.invalid });
  });

  it("ogni route sessionOnly → 403 con api:write, non 403 senza header", async () => {
    const routes: [string, string, unknown?][] = [
      ["GET", "/account/tokens"],
      ["POST", "/account/tokens", { name: "x", expiresInDays: 1 }],
      ["DELETE", "/account/tokens/999999"],
      ["POST", "/ai/accounts", {}],
      ["PATCH", "/ai/accounts/999999", {}],
      ["DELETE", "/ai/accounts/999999"],
      ["POST", "/ai/accounts/999999/verify"],
      ["POST", "/ai/accounts/999999/default"],
      ["POST", "/ai/accounts/999999/models", {}],
      ["PATCH", "/ai/models/999999", {}],
      ["PUT", "/budget", {}],
      ["DELETE", "/auth/github"],
    ];
    const token = await tokenWith(["api:write"]);
    for (const [method, path, body] of routes) {
      const withToken = await api(method, path, { token, body });
      expect(withToken.status, `${method} ${path}`).toBe(403);
      expect(withToken.json, `${method} ${path}`).toEqual({ error: MESSAGES.sessionOnly });
      const withoutHeader = await api(method, path, { body });
      expect(withoutHeader.status, `${method} ${path} senza header`).not.toBe(403);
    }
    // DELETE /auth/github esiste davvero (GitHub configurato): senza header non è un 404
    expect((await api("DELETE", "/auth/github")).status).not.toBe(404);
    // Le route vicine non sono solo con il login
    expect((await api("GET", "/ai/accounts", { token })).status).toBe(200);
    expect((await api("GET", "/budget", { token })).status).toBe(200);
  });

  it("GET /auth/me con token → auth.kind token e scopes; senza header → kind session", async () => {
    const token = await tokenWith(["api:write", "api:read"]);
    const me = await api("GET", "/auth/me", { token });
    expect(me.status, me.text).toBe(200);
    expect(me.json.email).toBe(TOKEN_EMAIL);
    expect(me.json.auth).toEqual({ kind: "token", scopes: ["api:read", "api:write"] });

    const dev = await api("GET", "/auth/me");
    expect(dev.status).toBe(200);
    expect(dev.json.email).toBe("dev@localhost");
    expect(dev.json.auth).toEqual({ kind: "session" });

    const mcpOnly = await api("GET", "/auth/me", { token: await tokenWith(["mcp"]) });
    expect(mcpOnly.status).toBe(403);
    expect(mcpOnly.json).toEqual({ error: MESSAGES.scope });
    const invalid = await api("GET", "/auth/me", { auth: "Bearer nulla" });
    expect(invalid.status).toBe(401);
    expect(invalid.json).toEqual({ error: MESSAGES.invalid });
  });

  it("121ª richiesta nel minuto con lo stesso token → 429; un altro token no", async () => {
    const token = await tokenWith(["api:read"]);
    const other = await tokenWith(["api:read"]);
    for (let i = 0; i < 120; i++) {
      const res = await api("GET", "/budget", { token });
      expect(res.status, `richiesta ${i + 1}`).toBe(200);
    }
    expect((await api("GET", "/budget", { token })).status).toBe(429);
    expect((await api("GET", "/budget", { token: other })).status).toBe(200);
    // Senza header (sessione) il limite per token non si applica
    expect((await api("GET", "/budget")).status).toBe(200);
  });

  it("il token non compare nei log", async () => {
    const token = await tokenWith(["api:write"]);
    const mcpOnly = await tokenWith(["mcp"]);
    logLines.length = 0;
    await api("GET", "/apps", { token });
    await api("POST", "/apps", { token, body: { name: "Log", baseUrl: "https://log.example.com" } });
    await api("GET", `/apps?token=x`, { token: mcpOnly });
    await api("PUT", "/budget", { token, body: {} });
    await api("GET", "/apps", { auth: `Basic ${token}` });
    // pino-http scrive a fine risposta: si aspetta che le righe arrivino
    await vi.waitFor(() => expect(logLines.length).toBeGreaterThanOrEqual(5));
    const all = logLines.join("\n");
    expect(all).toContain("/apps");
    for (const secret of [token, mcpOnly, "Bearer", "authorization", sha256(token), sha256(mcpOnly)]) {
      expect(all.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

// Metadati e registrazione OAuth sull'app completa (porta 0). Il limite di 10 registrazioni al minuto ha il suo
// file (oauth-register-limit.test.ts): qui se ne fanno meno di 10.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL"];
const saved: Record<string, string | undefined> = {};
let base: string;
let server: http.Server;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; res: Response }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, res };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    PUBLIC_APP_URL: "https://casello.example.test/",
  });
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE oauth_clients RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE oauth_clients RESTART IDENTITY CASCADE");
});

describe("metadati", () => {
  it("metadati: resource <base>/mcp, issuer, endpoint, S256, none, client_id_metadata_document_supported", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await call("GET", path);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({
        resource: "https://casello.example.test/mcp",
        authorization_servers: ["https://casello.example.test"],
        scopes_supported: ["mcp"],
        bearer_methods_supported: ["header"],
      });
    }
    const as = await call("GET", "/.well-known/oauth-authorization-server");
    expect(as.status).toBe(200);
    expect(as.json).toEqual({
      issuer: "https://casello.example.test",
      authorization_endpoint: "https://casello.example.test/oauth/authorize",
      token_endpoint: "https://casello.example.test/oauth/token",
      registration_endpoint: "https://casello.example.test/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      scopes_supported: ["mcp"],
    });
  });
});

describe("POST /oauth/register", () => {
  it("registra un client claude.ai: 201 con client_id cac_…", async () => {
    const r = await call("POST", "/oauth/register", {
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "Claude",
    });
    expect(r.status).toBe(201);
    expect(r.json.client_id).toMatch(/^cac_/);
    expect(r.json).toMatchObject({ client_name: "Claude", token_endpoint_auth_method: "none" });
  });

  it("redirect estraneo → 400 invalid_redirect_uri", async () => {
    for (const uri of ["https://evil.example/cb", "https://claude.ai/api/mcp/auth_callback/x", "http://localhost/altro"]) {
      const r = await call("POST", "/oauth/register", { redirect_uris: [uri] });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("invalid_redirect_uri");
      expect(typeof r.json.error_description).toBe("string");
    }
  });

  it("token_endpoint_auth_method client_secret_post → 400 invalid_client_metadata", async () => {
    const r = await call("POST", "/oauth/register", {
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_client_metadata");
  });

  it("più di 5 redirect → 400", async () => {
    const six = Array.from({ length: 6 }, (_, i) => `http://localhost:${4000 + i}/callback`);
    const r = await call("POST", "/oauth/register", { redirect_uris: six });
    expect(r.status).toBe(400);
  });
});

describe("errori su /oauth", () => {
  it("JSON malformato → 400 invalid_request in JSON OAuth", async () => {
    const res = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{non json" });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = (await res.json()) as { error: string; error_description: unknown };
    expect(json.error).toBe("invalid_request");
    expect(typeof json.error_description).toBe("string");
  });

  it("errore imprevisto → 500 server_error «errore interno»", async () => {
    const { oauthErrorHandler } = await import("./oauth");
    const express = (await import("express")).default;
    const app = express();
    app.get("/oauth/boom", () => {
      throw new Error("segreto del DB");
    });
    app.use("/oauth", oauthErrorHandler);
    const s = http.createServer(app);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/oauth/boom`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "server_error", error_description: "errore interno" });
    } finally {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

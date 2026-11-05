import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  db,
  pool,
  appToolsTable,
  appsTable,
  oauthGrantsTable,
  pendingActionsTable,
  usersTable,
  type InsertAppTool,
} from "@workspace/db";
import { enqueueAction } from "../src/lib/actions/queue";
import { encryptSecret } from "../src/lib/secrets";
import type { CatalogTool } from "../src/lib/tools/types";
import { allowTestLoopback } from "./fake-provider";
import { startFakeMcp, type FakeMcp } from "./fake-mcp";

// Flusso completo del connettore OAuth sull'app vera: metadati, registrazione, consenso, scambio del codice,
// uso del cao_ su /mcp (anche approva), rinnovo; poi i casi in cui il token smette di valere.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL"];
const saved: Record<string, string | undefined> = {};
const CB = "https://claude.ai/api/mcp/auth_callback";
const SCHEMA = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };

let base: string;
let server: http.Server;
let restoreLoopback: () => void;
let mcpApp: FakeMcp;
let userId: number;
let tool: CatalogTool;
let appId: number;

const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url");

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    PUBLIC_APP_URL: "https://casello.example.test",
  });
  restoreLoopback = allowTestLoopback();
  mcpApp = await startFakeMcp({ tools: [{ name: "set_pw", text: "fatto" }] });
  const { default: app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await mcpApp.close();
  restoreLoopback();
  await pool.query("TRUNCATE oauth_clients, apps, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  process.env["ALLOWED_EMAILS"] = "dev@localhost";
  await pool.query("TRUNCATE oauth_clients, apps, users RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "dev@localhost" }).returning();
  userId = u!.id;
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example", mcpUrl: mcpApp.url, serviceAuth: { header: "X-Key", scheme: null }, serviceSecretEnc: encryptSecret("seg") })
    .returning();
  appId = app!.id;
  const [row] = await db
    .insert(appToolsTable)
    .values({ appId, name: "set_pw", kind: "mcp", identity: "service", level: "L2", status: "active", paramsSchema: SCHEMA, definition: { mcpName: "set_pw" } } as InsertAppTool)
    .returning();
  tool = { ...row!, paramsSchema: SCHEMA, definition: row!.definition as CatalogTool["definition"] };
});

/** Registrazione + consenso + scambio: restituisce client e token. */
async function connectFlow(clientId?: string): Promise<{ clientId: string; access: string; refresh: string }> {
  if (!clientId) {
    const reg = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CB], client_name: "Claude", token_endpoint_auth_method: "none" }),
    });
    expect(reg.status).toBe(201);
    clientId = ((await reg.json()) as { client_id: string }).client_id;
  }
  const verifier = randomBytes(32).toString("base64url");
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CB,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
    state: "st-1",
    scope: "mcp",
    resource: "https://casello.example.test/mcp",
  });
  const page = await fetch(`${base}/oauth/authorize?${qs}`, { redirect: "manual" });
  expect(page.status).toBe(200);
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
  const dec = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrf, decision: "allow" }).toString(),
  });
  expect(dec.status).toBe(302);
  const loc = new URL(dec.headers.get("location")!);
  expect(`${loc.origin}${loc.pathname}`).toBe(CB);
  expect(loc.searchParams.get("state")).toBe("st-1");
  const tok = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, redirect_uri: CB, client_id: clientId, code_verifier: verifier }).toString(),
  });
  expect(tok.status).toBe(200);
  const json = (await tok.json()) as { access_token: string; refresh_token: string };
  return { clientId, access: json.access_token, refresh: json.refresh_token };
}

async function mcpClient(bearer: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return client;
}

async function rawMcp(bearer: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

const WWW = 'Bearer resource_metadata="https://casello.example.test/.well-known/oauth-protected-resource"';

describe("connettore OAuth: flusso completo", () => {
  it("flusso completo: metadati, register, authorize, Consenti, token, tools/list, approva, refresh", async () => {
    const challenge = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(WWW);

    const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string; authorization_servers: string[] };
    expect(pr.resource).toBe("https://casello.example.test/mcp");
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as { issuer: string; registration_endpoint: string };
    expect(as.issuer).toBe(pr.authorization_servers[0]);
    expect(as.registration_endpoint).toContain("/oauth/register");

    const { access, refresh, clientId } = await connectFlow();
    expect(access.startsWith("cao_")).toBe(true);

    const client = await mcpClient(access);
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["coda_da_confermare", "approva", "rifiuta"]));
    for (const n of ["approva", "rifiuta"]) {
      const t = tools.find((x) => x.name === n)!;
      expect(t.description).toContain("Prima di chiamarlo ripeti all'utente numero e sintesi della voce e chiedi conferma.");
      expect(t.annotations?.destructiveHint).toBe(true);
    }

    const out = await enqueueAction({ userId, appId, agentId: null, runId: null, tool, args: { id: "42" }, recipient: "Rosa", summary: "Imposta la password" });
    if (!out.ok) throw new Error("accodamento");
    const res = (await client.callTool({ name: "approva", arguments: { numero: out.number } })) as { isError?: boolean };
    expect(res.isError).not.toBe(true);
    expect((await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, out.number)))[0]!.status).not.toBe("pending");
    expect(mcpApp.calls).toHaveLength(1);
    await client.close();

    const rt = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }).toString(),
    });
    expect(rt.status).toBe(200);
    const next = (await rt.json()) as { access_token: string };
    expect((await rawMcp(next.access_token)).status).not.toBe(401);
  });

  it("cao_ su /api/team-instances → 401", async () => {
    const { access } = await connectFlow();
    const res = await fetch(`${base}/api/team-instances`, { headers: { authorization: `Bearer ${access}` } });
    expect(res.status).toBe(401);
  });

  it("collegamento revocato → 401 su /mcp", async () => {
    const { access } = await connectFlow();
    expect((await rawMcp(access)).status).not.toBe(401);
    await db.update(oauthGrantsTable).set({ revokedAt: new Date() });
    const res = await rawMcp(access);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(WWW);
  });

  it("nuovo consenso dello stesso client: il cao_ del collegamento precedente → 401", async () => {
    const first = await connectFlow();
    expect((await rawMcp(first.access)).status).not.toBe(401);
    const second = await connectFlow(first.clientId);
    expect((await rawMcp(first.access)).status).toBe(401);
    expect((await rawMcp(second.access)).status).not.toBe(401);
  });

  it("utente tolto da ALLOWED_EMAILS → 401", async () => {
    const { access } = await connectFlow();
    expect((await rawMcp(access)).status).not.toBe(401);
    process.env["ALLOWED_EMAILS"] = "altro@example.com";
    expect((await rawMcp(access)).status).toBe(401);
  });
});

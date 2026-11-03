import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, appsTable, appToolsTable, usersTable, type InsertAppTool } from "@workspace/db";
import { encryptSecret } from "../lib/secrets";
import type { CatalogTool } from "../lib/tools/types";
import type { TokenScope } from "../lib/api-tokens";
import { enqueueAction } from "../lib/actions/queue";
import { startFakeMcp, type FakeMcp } from "../../test/fake-mcp";
import { allowTestLoopback } from "../../test/fake-provider";

// Route della coda delle azioni sull'app completa (porta 0), con AUTH_DISABLED=true: senza header la
// richiesta è l'utente di sviluppo (dev@localhost); con un token vale solo il token. Gli utenti non si
// azzerano mai con RESTART IDENTITY: il limite delle decisioni è in memoria per id utente, e ogni test
// parte così da un contatore nuovo.

const DEV_EMAIL = "dev@localhost";
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const SCHEMA = {
  type: "object",
  properties: { id: { type: "string" }, password: { type: "string", "x-sensitive": true } },
  required: ["id"],
};

let base: string;
let server: http.Server;
let restoreLoopback: () => void;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;
let mcp: FakeMcp;
let userId: number;
let appId: number;
let tool: CatalogTool;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

const tokenWith = async (scopes: TokenScope[]) => (await createApiToken(userId, "Script", 30, scopes)).token;

async function enqueue(args: Record<string, unknown> = { id: "42", password: "segreta-123" }) {
  const out = await enqueueAction({ userId, appId, agentId: null, runId: null, tool, args, recipient: "Rosa", summary: "Cambia la password di Rosa" });
  if (!out.ok) throw new Error(out.message);
  return out.number;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: DEV_EMAIL, CASELLO_SECRET_KEY: "a".repeat(64) });
  restoreLoopback = allowTestLoopback();
  const { default: app } = await import("../app");
  ({ createApiToken } = await import("../lib/api-tokens"));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mcp = await startFakeMcp({ tools: [{ name: "set_password", text: "impostata a segreta-123" }] });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await mcp.close();
  restoreLoopback();
  await pool.query("TRUNCATE apps, users CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  mcp.calls.length = 0;
  await pool.query("TRUNCATE apps, users CASCADE");
  const [user] = await db.insert(usersTable).values({ email: DEV_EMAIL, name: "Dev" }).returning();
  userId = user!.id;
  const [app] = await db
    .insert(appsTable)
    .values({
      name: "Mister",
      slug: "mister",
      baseUrl: "http://mister.example",
      mcpUrl: mcp.url,
      serviceAuth: { header: "X-Service-Key", scheme: null },
      serviceSecretEnc: encryptSecret("segreto-servizio"),
    })
    .returning();
  appId = app!.id;
  const [row] = await db
    .insert(appToolsTable)
    .values({
      appId,
      name: "set_password",
      kind: "mcp",
      identity: "service",
      level: "L2",
      status: "active",
      paramsSchema: SCHEMA,
      definition: { mcpName: "set_password" },
    } as InsertAppTool)
    .returning();
  tool = { ...row!, paramsSchema: SCHEMA, definition: row!.definition as CatalogTool["definition"] };
});

describe("GET /pending-actions", () => {
  it("elenca per default le pending, numero decrescente; filtro per stato; degli altri utenti niente", async () => {
    const n1 = await enqueue();
    const n2 = await enqueue({ id: "7" });
    await api("POST", `/pending-actions/${n1}/reject`, { body: { note: "no" } });
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
    await enqueueAction({ userId: other!.id, appId, agentId: null, runId: null, tool, args: { id: "1" }, recipient: "X", summary: "Altro" });

    const pending = await api("GET", "/pending-actions");
    expect(pending.status).toBe(200);
    expect(pending.json.actions.map((a: { number: number }) => a.number)).toEqual([n2]);
    const all = await api("GET", "/pending-actions?status=all");
    expect(all.json.actions.map((a: { number: number }) => a.number)).toEqual([n2, n1]);
    const rejected = await api("GET", "/pending-actions?status=rejected");
    expect(rejected.json.actions[0]).toMatchObject({
      number: n1,
      status: "rejected",
      app: { id: appId, name: "Mister" },
      tool: { id: tool.id, name: "set_password", identity: "service" },
      recipient: "Rosa",
      decisionNote: "no",
      args: { id: "42", password: "***" },
    });
    expect((await api("GET", "/pending-actions?status=boh")).status).toBe(400);
  });

  it("dettaglio: 200 senza valori sensibili, 404 se inesistente", async () => {
    const n = await enqueue();
    const res = await api("GET", `/pending-actions/${n}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("segreta-123");
    expect((await api("GET", "/pending-actions/999")).status).toBe(404);
  });
});

describe("approvazione e rifiuto via API", () => {
  it("approve esegue una volta; la risposta e le letture successive non contengono valori sensibili", async () => {
    const n = await enqueue();
    const res = await api("POST", `/pending-actions/${n}/approve`);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ number: n, status: "done", result: "impostata a ***", errorMessage: null });
    expect(res.text).not.toContain("segreta-123");
    expect(mcp.calls).toHaveLength(1);
    expect(mcp.calls[0]!.args).toEqual({ id: "42", password: "segreta-123" });
    expect((await api("GET", `/pending-actions/${n}`)).text).not.toContain("segreta-123");
    expect((await api("POST", `/pending-actions/${n}/approve`)).status).toBe(409);
  });

  it("reject: nota oltre 500 caratteri → 400; poi rifiuto con nota", async () => {
    const n = await enqueue();
    expect((await api("POST", `/pending-actions/${n}/reject`, { body: { note: "x".repeat(501) } })).status).toBe(400);
    const res = await api("POST", `/pending-actions/${n}/reject`, { body: { note: "no" } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "rejected", decisionNote: "no" });
    expect((await api("POST", `/pending-actions/${n}/reject`)).status).toBe(409);
  });

  it("voce di un altro utente: 404 su dettaglio, approve e reject", async () => {
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
    const out = await enqueueAction({ userId: other!.id, appId, agentId: null, runId: null, tool, args: { id: "1" }, recipient: "X", summary: "Altro" });
    const n = out.ok ? out.number : 0;
    expect((await api("GET", `/pending-actions/${n}`)).status).toBe(404);
    expect((await api("POST", `/pending-actions/${n}/approve`)).status).toBe(404);
    expect((await api("POST", `/pending-actions/${n}/reject`)).status).toBe(404);
    expect(mcp.calls).toHaveLength(0);
  });

  it("token api:read: GET 200, approve e reject 403; api:write approva", async () => {
    const n = await enqueue();
    const read = await tokenWith(["api:read"]);
    expect((await api("GET", "/pending-actions", { token: read })).status).toBe(200);
    expect((await api("POST", `/pending-actions/${n}/approve`, { token: read })).status).toBe(403);
    expect((await api("POST", `/pending-actions/${n}/reject`, { token: read })).status).toBe(403);
    expect(mcp.calls).toHaveLength(0);
    const write = await tokenWith(["api:write"]);
    expect((await api("POST", `/pending-actions/${n}/approve`, { token: write })).status).toBe(200);
  });

  it("la 21ª decisione nel minuto → 429", async () => {
    let last = 0;
    for (let i = 1; i <= 21; i++) last = (await api("POST", `/pending-actions/${i}/reject`)).status;
    expect(last).toBe(429);
  });
});

describe("GET /dashboard/stats", () => {
  it("pendingActions conta le pending dell'utente corrente", async () => {
    await enqueue();
    const n2 = await enqueue();
    await enqueue();
    await api("POST", `/pending-actions/${n2}/reject`);
    const res = await api("GET", "/dashboard/stats");
    expect(res.status).toBe(200);
    expect(res.json.pendingActions).toBe(2);
  });
});

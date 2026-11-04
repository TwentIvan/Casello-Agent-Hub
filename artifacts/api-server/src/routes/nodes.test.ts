import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiTokensTable, db, nodesTable, pool, usersTable } from "@workspace/db";

// Nodi locali e token d'ambito `node`, sull'app completa (porta 0) con AUTH_DISABLED=true: senza header la
// richiesta passa come «sessione» di sviluppo (dev@localhost), con l'header conta solo il token.
// Le tabelle si svuotano SENZA ripartire con gli id: il limite per token è in memoria per id.

const MSG = {
  invalid: "token non valido o scaduto",
  scope: "il token non ha l'ambito per questa operazione",
  sessionOnly: "operazione disponibile solo con il login",
};
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"];
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;
let createNode: typeof import("../lib/nodes/nodes").createNode;
let otherUserId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, opts: { token?: string; body?: unknown; prefix?: string } = {}): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${opts.prefix ?? "/api"}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.includes("application/json") ?? false;
  return { status: res.status, text, json: isJson && text ? JSON.parse(text) : undefined };
}

async function devUserId(): Promise<number> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  if (user) return user.id;
  const [created] = await db.insert(usersTable).values({ email: "dev@localhost", name: "Sviluppo locale" }).returning();
  return created!.id;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: "dev@localhost,altro@example.com", CASELLO_SECRET_KEY: "a".repeat(64) });
  const { default: app } = await import("../app");
  ({ createApiToken } = await import("../lib/api-tokens"));
  ({ createNode } = await import("../lib/nodes/nodes"));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE users CASCADE");
  const [other] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
  otherUserId = other!.id;
});

describe("nodi registrati", () => {
  it("crea con il token mostrato una volta (a riposo solo l'hash) e lo elenca senza token", async () => {
    const created = await api("POST", "/account/nodes", { body: { name: "Mac di Ivan" } });
    expect(created.status, created.text).toBe(201);
    expect(created.json.token).toMatch(/^cas_/);
    expect(created.json.node).toMatchObject({ name: "Mac di Ivan", status: "active", skills: [], maxConcurrent: 1, lastSeenAt: null, online: false });

    const rows = await db.select().from(apiTokensTable).where(eq(apiTokensTable.nodeId, created.json.node.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopes).toEqual(["node"]);
    expect(rows[0]!.tokenHash).toBe(createHash("sha256").update(created.json.token).digest("hex"));
    expect(rows[0]!.tokenHash).not.toBe(created.json.token);

    const list = await api("GET", "/account/nodes");
    expect(list.status).toBe(200);
    expect(list.json).toHaveLength(1);
    expect(list.text).not.toContain(created.json.token);
    expect(list.text).not.toContain("tokenHash");
    // il token del nodo non compare tra i token personali
    expect((await api("GET", "/account/tokens")).json).toEqual([]);
  });

  it("nome vuoto → 400; nome ripetuto → 409 «nome già usato», ma un altro utente può usarlo", async () => {
    expect((await api("POST", "/account/nodes", { body: { name: "  " } })).status).toBe(400);
    expect((await api("POST", "/account/nodes", { body: { name: "Mac" } })).status).toBe(201);
    const dup = await api("POST", "/account/nodes", { body: { name: "Mac" } });
    expect(dup.status).toBe(409);
    expect(dup.json).toEqual({ error: "nome già usato" });
    expect((await createNode(otherUserId, "Mac")).node.name).toBe("Mac");
  });

  it("online solo se visto negli ultimi 2 minuti", async () => {
    const { node } = await createNode(await devUserId(), "Vivo");
    await db.update(nodesTable).set({ lastSeenAt: new Date(Date.now() - 60_000) }).where(eq(nodesTable.id, node.id));
    expect((await api("GET", "/account/nodes")).json[0].online).toBe(true);
    await db.update(nodesTable).set({ lastSeenAt: new Date(Date.now() - 5 * 60_000) }).where(eq(nodesTable.id, node.id));
    expect((await api("GET", "/account/nodes")).json[0].online).toBe(false);
  });

  it("token node: heartbeat 200; su altre route di /api → 403; su /mcp → 401", async () => {
    const { token } = await createNode(await devUserId(), "Mac");
    const hb = await api("POST", "/node/heartbeat", { token });
    expect(hb.status, hb.text).toBe(200);
    expect(hb.json).toEqual({ pending: 0 });

    for (const [method, path] of [["GET", "/team-instances"], ["GET", "/apps"], ["POST", "/apps"], ["GET", "/auth/me"], ["GET", "/account/nodes"]] as const) {
      const res = await api(method, path, { token });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json).toEqual({ error: MSG.scope });
    }
    const mcp = await api("POST", "", { token, prefix: "/mcp", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(mcp.status).toBe(401);
    expect(mcp.json).toEqual({ error: MSG.invalid });
  });

  it("sessione e token senza node sulle route /api/node → 403; token sconosciuto → 401", async () => {
    expect((await api("POST", "/node/heartbeat")).status).toBe(403);
    const userId = await devUserId();
    for (const scopes of [["mcp"], ["api:read"], ["api:write"]] as const) {
      const { token } = await createApiToken(userId, "Script", 30, [...scopes]);
      const res = await api("POST", "/node/heartbeat", { token });
      expect(res.status, scopes.join()).toBe(403);
      expect(res.json).toEqual({ error: MSG.scope });
    }
    expect((await api("POST", "/node/heartbeat", { token: "cas_sconosciuto" })).status).toBe(401);
  });

  it("nodo disattivato → 403 sul protocollo", async () => {
    const { node, token } = await createNode(await devUserId(), "Mac");
    expect((await api("POST", `/account/nodes/${node.id}/disable`)).json.status).toBe("disabled");
    const hb = await api("POST", "/node/heartbeat", { token });
    expect(hb.status).toBe(403);
  });

  it("rigenerazione: il token vecchio è revocato e quello nuovo vale", async () => {
    const { node, token } = await createNode(await devUserId(), "Mac");
    const regen = await api("POST", `/account/nodes/${node.id}/token`);
    expect(regen.status, regen.text).toBe(200);
    expect(regen.json.token).toMatch(/^cas_/);
    expect(regen.json.token).not.toBe(token);
    const old = await api("POST", "/node/heartbeat", { token });
    expect(old.status).toBe(401);
    expect((await api("POST", "/node/heartbeat", { token: regen.json.token })).status).toBe(200);
  });

  it("elimina il nodo e i suoi token", async () => {
    const { node, token } = await createNode(await devUserId(), "Mac");
    expect((await api("DELETE", `/account/nodes/${node.id}`)).status).toBe(204);
    expect(await db.select().from(apiTokensTable).where(eq(apiTokensTable.nodeId, node.id))).toHaveLength(0);
    expect((await api("POST", "/node/heartbeat", { token })).status).toBe(401);
    expect((await api("DELETE", `/account/nodes/${node.id}`)).status).toBe(404);
  });

  it("POST /account/tokens con scopes node → 400; token personali non si gestiscono con un token", async () => {
    const res = await api("POST", "/account/tokens", { body: { name: "X", expiresInDays: 30, scopes: ["node"] } });
    expect(res.status).toBe(400);
    const { token } = await createApiToken(await devUserId(), "Script", 30, ["api:write"]);
    for (const [method, path, body] of [["GET", "/account/nodes"], ["POST", "/account/nodes", { name: "Z" }]] as const) {
      const out = await api(method, path, { token, body });
      expect(out.status, path).toBe(403);
      expect(out.json).toEqual({ error: MSG.sessionOnly });
    }
  });

  it("nodi di un altro utente: 404 e invisibili", async () => {
    const { node } = await createNode(otherUserId, "Altrui");
    expect((await api("GET", "/account/nodes")).json).toEqual([]);
    expect((await api("POST", `/account/nodes/${node.id}/disable`)).status).toBe(404);
    expect((await api("POST", `/account/nodes/${node.id}/token`)).status).toBe(404);
    expect((await api("DELETE", `/account/nodes/${node.id}`)).status).toBe(404);
    const [row] = await db.select().from(nodesTable).where(eq(nodesTable.id, node.id));
    expect(row!.status).toBe("active");
  });
});

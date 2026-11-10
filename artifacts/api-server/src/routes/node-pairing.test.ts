import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiTokensTable, db, nodePairingsTable, nodesTable, pool, usersTable } from "@workspace/db";

// Abbinamento dei nodi dal browser, sull'app completa (porta 0) con AUTH_DISABLED=true: senza header la richiesta
// passa come «sessione» di sviluppo (dev@localhost). Le richieste di abbinamento si creano col servizio (le `start`
// via HTTP hanno un limite per IP, in memoria): solo due test passano dalla route.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"];
const saved: Record<string, string | undefined> = {};
const CODE_RE = /^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/;
const HEARTBEAT = { version: "0.2.0", executor: "claude-code", skills: [], workspaceRoot: "/radice", maxConcurrent: 1 };
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

let base: string;
let server: http.Server;
let pairing: typeof import("../lib/nodes/pairing");
let createApiToken: typeof import("../lib/api-tokens").createApiToken;
let createNode: typeof import("../lib/nodes/nodes").createNode;
let resetLimits: () => void;
let otherUserId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
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

async function newPairing(deviceName = "MacBook di Ivan") {
  return pairing.startPairing({ deviceName, version: "0.3.0", ip: "203.0.113.77" });
}

const poll = (p: { pairingId: string; pollSecret: string }) => api("POST", "/node-pairing/poll", { body: { pairingId: p.pairingId, pollSecret: p.pollSecret } });

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: "dev@localhost,altro@example.com", CASELLO_SECRET_KEY: "a".repeat(64) });
  const { default: app } = await import("../app");
  pairing = await import("../lib/nodes/pairing");
  ({ createApiToken } = await import("../lib/api-tokens"));
  ({ createNode } = await import("../lib/nodes/nodes"));
  ({ resetNodePairingLimits: resetLimits } = await import("../middlewares/rate-limit"));
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
  resetLimits();
  await pool.query("TRUNCATE users CASCADE");
  await pool.query("TRUNCATE node_pairings");
  const [other] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
  otherUserId = other!.id;
});

describe("abbinamento dei nodi", () => {
  it("start: 201 con codice XXXX-XXXX e segreto di 43 caratteri, nel DB solo gli hash", async () => {
    const res = await api("POST", "/node-pairing/start", { body: { deviceName: "MacBook di Ivan", version: "0.3.0" } });
    expect(res.status, res.text).toBe(201);
    expect(res.json.userCode).toMatch(CODE_RE);
    expect(res.json.pollSecret).toHaveLength(43);
    const [row] = await db.select().from(nodePairingsTable);
    expect(row!.id).toBe(res.json.pairingId);
    expect(row!.status).toBe("pending");
    expect(row!.userCodeHash).toBe(sha(res.json.userCode.replace("-", "")));
    expect(row!.pollSecretHash).toBe(sha(res.json.pollSecret));
    expect(JSON.stringify(row)).not.toContain(res.json.pollSecret);
    expect(JSON.stringify(row)).not.toContain(res.json.userCode);
    expect(row!.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(row!.requestIp).toBe("127.0.0.0/24");
  });

  it("poll prima dell'approvazione → 202 pending; segreto sbagliato → 410", async () => {
    const p = await newPairing();
    const res = await poll(p);
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ status: "pending" });
    const bad = await poll({ pairingId: p.pairingId, pollSecret: "x".repeat(43) });
    expect(bad.status).toBe(410);
    expect(bad.json).toEqual({ error: "collegamento non più valido" });
    expect((await poll({ pairingId: "non-un-uuid", pollSecret: p.pollSecret })).status).toBe(410);
  });

  it("GET con login: dati della richiesta, codice con o senza trattino e in minuscolo; con un token personale → 403", async () => {
    const p = await newPairing();
    for (const code of [p.userCode, p.userCode.replace("-", ""), p.userCode.toLowerCase()]) {
      const res = await api("GET", `/account/node-pairings/${code}`);
      expect(res.status, code).toBe(200);
      expect(res.json).toMatchObject({ deviceName: "MacBook di Ivan", version: "0.3.0" });
      expect(typeof res.json.createdAt).toBe("string");
    }
    const { token } = await createApiToken(await devUserId(), "Script", 30, ["api:write"]);
    const res = await api("GET", `/account/node-pairings/${p.userCode}`, { token });
    expect(res.status).toBe(403);
    expect((await api("GET", "/account/node-pairings/ZZZZ-ZZZZ")).status).toBe(404);
  });

  it("approve poi poll: token cas_ consegnato una volta, funziona sull'heartbeat; secondo poll → 410", async () => {
    const p = await newPairing();
    const ok = await api("POST", `/account/node-pairings/${p.userCode}/approve`, { body: { name: "MacBook di prova" } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toEqual({ status: "approved" });
    // il token non si crea all'approvazione
    expect(await db.select().from(apiTokensTable)).toHaveLength(0);

    const res = await poll(p);
    expect(res.status, res.text).toBe(200);
    expect(res.json.token).toMatch(/^cas_/);
    expect(res.json.nodeName).toBe("MacBook di prova");
    const [node] = await db.select().from(nodesTable).where(eq(nodesTable.id, res.json.nodeId));
    expect(node!.userId).toBe(await devUserId());
    expect(node!.pairedAt).not.toBeNull();
    expect(node!.pairedIp).toBe("203.0.113.0/24");

    const hb = await api("POST", "/node/heartbeat", { token: res.json.token, body: HEARTBEAT });
    expect(hb.status, hb.text).toBe(200);
    expect((await poll(p)).status).toBe(410);
    // una richiesta decisa non si vede più
    expect((await api("GET", `/account/node-pairings/${p.userCode}`)).status).toBe(404);
  });

  it("due poll concorrenti dopo l'approvazione → esattamente un 200 e un solo token", async () => {
    const p = await newPairing();
    await api("POST", `/account/node-pairings/${p.userCode}/approve`, { body: { name: "Mac" } });
    const out = await Promise.all([poll(p), poll(p), poll(p)]);
    expect(out.filter((r) => r.status === 200)).toHaveLength(1);
    expect(out.filter((r) => r.status === 410)).toHaveLength(2);
    expect(await db.select().from(apiTokensTable)).toHaveLength(1);
  });

  it("replaceNodeId: stesso nodo, vecchio token revocato, nome invariato; nodo di un altro utente → 404", async () => {
    const userId = await devUserId();
    const old = await createNode(userId, "Mac vecchio");
    expect((await api("POST", "/node/heartbeat", { token: old.token, body: HEARTBEAT })).status).toBe(200);

    const p = await newPairing("Nome ignorato");
    const ok = await api("POST", `/account/node-pairings/${p.userCode}/approve`, { body: { name: "Ignorato", replaceNodeId: old.node.id } });
    expect(ok.status, ok.text).toBe(200);
    expect((await api("POST", "/node/heartbeat", { token: old.token, body: HEARTBEAT })).status).toBe(401);

    const res = await poll(p);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ nodeId: old.node.id, nodeName: "Mac vecchio" });
    expect((await api("POST", "/node/heartbeat", { token: res.json.token, body: HEARTBEAT })).status).toBe(200);

    const foreign = await createNode(otherUserId, "Mac altrui");
    const p2 = await newPairing();
    const bad = await api("POST", `/account/node-pairings/${p2.userCode}/approve`, { body: { name: "x", replaceNodeId: foreign.node.id } });
    expect(bad.status).toBe(404);
    expect(bad.json).toEqual({ error: "nodo non trovato" });
  });

  it("replaceNodeId azzera le richieste del Mac vecchio: il primo heartbeat del nuovo non ha uninstallRequested", async () => {
    const userId = await devUserId();
    const old = await createNode(userId, "Mac da sostituire");
    await db
      .update(nodesTable)
      .set({
        uninstallRequestedAt: new Date(),
        diagnosticsRequestedAt: new Date(),
        updateFailedVersion: "0.9.0",
        kind: "app",
        claudeStatus: { found: true, loggedIn: false },
        claudeCheckedAt: new Date(),
      })
      .where(eq(nodesTable.id, old.node.id));
    const p = await newPairing();
    const ok = await api("POST", `/account/node-pairings/${p.userCode}/approve`, { body: { name: "x", replaceNodeId: old.node.id } });
    expect(ok.status, ok.text).toBe(200);
    const res = await poll(p);
    expect(res.status).toBe(200);
    const hb = await api("POST", "/node/heartbeat", { token: res.json.token, body: HEARTBEAT });
    expect(hb.status, hb.text).toBe(200);
    expect(hb.json.uninstallRequested).toBeUndefined();
    expect(hb.json.diagnosticsRequested).toBeUndefined();
    const [node] = await db.select().from(nodesTable).where(eq(nodesTable.id, old.node.id));
    expect(node).toMatchObject({ uninstallRequestedAt: null, diagnosticsRequestedAt: null, updateFailedVersion: null, claudeStatus: null, claudeCheckedAt: null });
  });

  it("GET /account/nodes dopo l'abbinamento riporta pairedAt e pairedIp abbreviato", async () => {
    const p = await newPairing();
    await api("POST", `/account/node-pairings/${p.userCode}/approve`, { body: { name: "Mac con IP" } });
    const res = await poll(p);
    expect(res.status).toBe(200);
    const list = await api("GET", "/account/nodes");
    expect(list.status, list.text).toBe(200);
    const node = list.json.find((n: { id: number }) => n.id === res.json.nodeId);
    expect(node).toMatchObject({ pairedIp: "203.0.113.0/24", pairedAt: expect.any(String) });
  });

  it("nome già usato → 409; deny → poll 410", async () => {
    await createNode(await devUserId(), "Mac");
    const p = await newPairing();
    const dup = await api("POST", `/account/node-pairings/${p.userCode}/approve`, { body: { name: "Mac" } });
    expect(dup.status).toBe(409);
    expect(dup.json).toEqual({ error: "nome già usato" });

    const denied = await api("POST", `/account/node-pairings/${p.userCode}/deny`);
    expect(denied.status, denied.text).toBe(200);
    expect(denied.json).toEqual({ status: "denied" });
    expect((await poll(p)).status).toBe(410);
    expect((await api("POST", `/account/node-pairings/${p.userCode}/approve`, { body: { name: "Altro" } })).status).toBe(404);
  });

  it("richiesta scaduta: GET 404 col messaggio fisso, approve 404, poll 410", async () => {
    const p = await newPairing();
    await db.update(nodePairingsTable).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(nodePairingsTable.id, p.pairingId));
    const res = await api("GET", `/account/node-pairings/${p.userCode}`);
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "richiesta di collegamento non trovata o scaduta" });
    expect((await api("POST", `/account/node-pairings/${p.userCode}/approve`, { body: { name: "Mac" } })).status).toBe(404);
    expect((await poll(p)).status).toBe(410);
  });

  it("5 approvazioni fallite → la richiesta passa a expired", async () => {
    const p = await newPairing();
    for (let i = 0; i < 5; i++) {
      const res = await api("POST", `/account/node-pairings/${p.userCode}/approve`, { body: { name: "" } });
      expect(res.status, `tentativo ${i + 1}`).toBe(400);
    }
    const [row] = await db.select().from(nodePairingsTable);
    expect(row!.status).toBe("expired");
    expect((await api("POST", `/account/node-pairings/${p.userCode}/approve`, { body: { name: "Mac" } })).status).toBe(404);
    expect((await poll(p)).status).toBe(410);
  });

  it("l'11ª start dallo stesso IP in un minuto → 429", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await api("POST", "/node-pairing/start", { body: { deviceName: "Mac", version: "0.3.0" } });
      expect(res.status, `start ${i + 1}`).toBe(201);
    }
    expect((await api("POST", "/node-pairing/start", { body: { deviceName: "Mac", version: "0.3.0" } })).status).toBe(429);
  });

  it("approvazione a ridosso della scadenza: il poll dopo i 10 minuti dà comunque il token", async () => {
    const created = new Date("2026-01-01T10:00:00Z");
    const p = await pairing.startPairing({ deviceName: "Mac", version: "0.3.0", ip: "203.0.113.5" }, created);
    await pairing.approvePairing(await devUserId(), p.userCode, { name: "Ultimo minuto" }, new Date(created.getTime() + 9 * 60_000 + 59_000));
    const out = await pairing.pollPairing(p.pairingId, p.pollSecret, new Date(created.getTime() + 11 * 60_000));
    expect(out).toMatchObject({ status: "approved", nodeName: "Ultimo minuto" });
    // oltre la proroga di 2 minuti la richiesta non vale più
    const q = await pairing.startPairing({ deviceName: "Mac", version: "0.3.0" }, created);
    await pairing.approvePairing(await devUserId(), q.userCode, { name: "Tardi" }, new Date(created.getTime() + 9 * 60_000));
    await expect(pairing.pollPairing(q.pairingId, q.pollSecret, new Date(created.getTime() + 12 * 60_000))).rejects.toMatchObject({ status: 410 });
  });

  it("redactPairingPath nasconde il codice nei log e tiene l'azione", () => {
    expect(pairing.redactPairingPath("/api/account/node-pairings/ABCD-EFGH")).toBe("/api/account/node-pairings/***");
    expect(pairing.redactPairingPath("/api/account/node-pairings/abcdefgh/approve")).toBe("/api/account/node-pairings/***/approve");
    expect(pairing.redactPairingPath("/api/account/node-pairings/ABCD-EFGH/deny")).toBe("/api/account/node-pairings/***/deny");
    expect(pairing.redactPairingPath("/api/account/nodes/3")).toBe("/api/account/nodes/3");
  });

  it("la pulizia cancella le richieste create da oltre 1 ora, in qualunque stato", async () => {
    const old = await newPairing();
    const fresh = await newPairing();
    const consumed = await newPairing();
    const hourAgo = new Date(Date.now() - 61 * 60_000);
    await db.update(nodePairingsTable).set({ createdAt: hourAgo }).where(eq(nodePairingsTable.id, old.pairingId));
    await db.update(nodePairingsTable).set({ createdAt: hourAgo, status: "consumed" }).where(eq(nodePairingsTable.id, consumed.pairingId));
    expect(await pairing.purgeNodePairings()).toBe(2);
    const rows = await db.select().from(nodePairingsTable);
    expect(rows.map((r) => r.id)).toEqual([fresh.pairingId]);
  });
});

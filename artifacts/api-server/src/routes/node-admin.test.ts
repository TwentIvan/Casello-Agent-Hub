import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, nodeDiagnosticsTable, nodesTable, pool, usersTable } from "@workspace/db";
import { resetNodeManifestCache } from "../lib/nodes/manifest";
import { turnPollSettings } from "../lib/node-turns/protocol";
import { purgeNodeDiagnostics } from "../lib/nodes/node-admin";
import { queueSample, seedNodeTurnSetup } from "../../test/node-turn-fixture";
import { catalogSkill, ensureUser, nodeRole, seedNodeTeam } from "../../test/team-node-fixture";
import { startTask } from "../lib/teams/task-runner";

// Heartbeat esteso, aggiornamenti, impostazioni, diagnosi, disinstallazione e avvisi della Dashboard
// (spec «Botcave Nodo senza terminale» §5-§8). Ogni test usa nodi nuovi: i limiti per nodo sono in memoria per id.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "NODO_MANIFEST_PATH", "PUBLIC_APP_URL"];
const saved: Record<string, string | undefined> = {};
const dir = mkdtempSync(join(tmpdir(), "node-admin-"));
const MANIFEST = {
  version: "0.3.0",
  minVersion: "0.2.0",
  binary: { file: "casello-nodo-0.3.0", sha256: "b".repeat(64), size: 1234 },
  app: { file: "Botcave-Nodo-0.3.0.zip", sha256: "a".repeat(64), size: 99 },
};

let base: string;
let server: http.Server;
let createNode: typeof import("../lib/nodes/nodes").createNode;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;
let userId: number;
let otherUserId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, opts: { token?: string; body?: unknown; raw?: string } = {}): Promise<{ status: number; text: string; json: any; headers: Headers }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.includes("application/json") ?? false;
  return { status: res.status, text, json: isJson && text ? JSON.parse(text) : undefined, headers: res.headers };
}

const caps = (over: Record<string, unknown> = {}) => ({ version: "0.2.5", executor: "claude-code", skills: [], workspaceRoot: "/radice", maxConcurrent: 1, ...over });

function useManifest(manifest: unknown | null): void {
  const path = join(dir, `m-${Math.random().toString(36).slice(2)}.json`);
  if (manifest !== null) writeFileSync(path, JSON.stringify(manifest));
  process.env["NODO_MANIFEST_PATH"] = path;
  resetNodeManifestCache();
}

async function newNode(name = `Mac-${Math.random().toString(36).slice(2, 8)}`, owner = userId) {
  const { node, token } = await createNode(owner, name);
  return { id: node.id, token };
}

const nodeRow = async (id: number) => (await db.select().from(nodesTable).where(eq(nodesTable.id, id)))[0]!;
const listed = async (id: number) => (await api("GET", "/account/nodes")).json.find((n: { id: number }) => n.id === id);

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: "dev@localhost,altro@example.com", CASELLO_SECRET_KEY: "a".repeat(64), PUBLIC_APP_URL: "https://botcave.example.com" });
  const { default: app } = await import("../app");
  ({ createNode } = await import("../lib/nodes/nodes"));
  ({ createApiToken } = await import("../lib/api-tokens"));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users, skills, apps, team_instances RESTART IDENTITY CASCADE");
  rmSync(dir, { recursive: true, force: true });
  resetNodeManifestCache();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, skills, apps, team_instances CASCADE");
  userId = await ensureUser("dev@localhost");
  otherUserId = await ensureUser("altro@example.com");
  useManifest(null);
});

describe("heartbeat: compatibilità", () => {
  it("un nodo che manda il corpo di sempre riceve 200 {pending} e nessun campo nuovo", async () => {
    useManifest(MANIFEST);
    const { token } = await newNode();
    const hb = await api("POST", "/node/heartbeat", { token, body: caps() });
    expect(hb.status, hb.text).toBe(200);
    expect(hb.json).toEqual({ pending: 0 });
  });
});

describe("aggiornamenti", () => {
  it("kind app: update con required false sopra la minima, true sotto; cli e senza kind: nessun update", async () => {
    useManifest(MANIFEST);
    const a = await newNode();
    const hb = await api("POST", "/node/heartbeat", { token: a.token, body: caps({ kind: "app" }) });
    expect(hb.json).toEqual({ pending: 0, update: { version: "0.3.0", sha256: "b".repeat(64), size: 1234, required: false } });

    const b = await newNode();
    const old = await api("POST", "/node/heartbeat", { token: b.token, body: caps({ kind: "app", version: "0.1.9" }) });
    expect(old.json.update).toMatchObject({ version: "0.3.0", required: true });

    const c = await newNode();
    expect((await api("POST", "/node/heartbeat", { token: c.token, body: caps({ kind: "cli" }) })).json).toEqual({ pending: 0 });
    const d = await newNode();
    expect((await api("POST", "/node/heartbeat", { token: d.token, body: caps() })).json).toEqual({ pending: 0 });
  });

  it("nodo aggiornato all'ultima versione: nessun update", async () => {
    useManifest(MANIFEST);
    const { token } = await newNode();
    expect((await api("POST", "/node/heartbeat", { token, body: caps({ kind: "app", version: "0.3.0" }) })).json.update).toBeUndefined();
  });

  it("kind non valido → 400", async () => {
    const { token } = await newNode();
    expect((await api("POST", "/node/heartbeat", { token, body: caps({ kind: "boh" }) })).status).toBe(400);
  });

  it("updateFailed: salvato, niente update per quella versione, di nuovo con un manifest più nuovo", async () => {
    useManifest(MANIFEST);
    const { id, token } = await newNode();
    const hb = await api("POST", "/node/heartbeat", { token, body: caps({ kind: "app", updateFailed: "0.3.0" }) });
    expect(hb.json).toEqual({ pending: 0 });
    expect((await nodeRow(id)).updateFailedVersion).toBe("0.3.0");
    expect((await listed(id)).updateFailedVersion).toBe("0.3.0");

    useManifest({ ...MANIFEST, version: "0.3.1" });
    const next = await api("POST", "/node/heartbeat", { token, body: caps({ kind: "app" }) });
    expect(next.json.update).toMatchObject({ version: "0.3.1" });
  });

  it("la console vede updateAvailable e belowMinVersion", async () => {
    useManifest(MANIFEST);
    const { id, token } = await newNode();
    await api("POST", "/node/heartbeat", { token, body: caps({ kind: "app", version: "0.1.9" }) });
    expect(await listed(id)).toMatchObject({ kind: "app", version: "0.1.9", updateAvailable: "0.3.0", belowMinVersion: true });
  });
});

describe("versione minima", () => {
  it("sotto minVersion i claim dei compiti e dei turni rispondono 204 anche con lavoro in coda", async () => {
    await catalogSkill("sap-abap", "node", "sap:abap-developer");
    const instanceId = await seedNodeTeam({ userId, roles: [nodeRole({ skills: [{ code: "sap-abap", version: 1 }] })], tasks: { t1: "operaio" } });
    await startTask(instanceId, "t1");
    const setup = await seedNodeTurnSetup("dev@localhost", "Mac turni");
    await queueSample(setup);
    useManifest(MANIFEST);
    const prevWait = turnPollSettings.waitMs;
    turnPollSettings.waitMs = 0;
    try {
      const old = await api("POST", "/node/heartbeat", { token: setup.nodeToken, body: caps({ version: "0.1.9", skills: ["sap:abap-developer"] }) });
      expect(old.status, old.text).toBe(200);
      expect((await api("POST", "/node/claim", { token: setup.nodeToken })).status).toBe(204);
      expect((await api("POST", "/node/turns/claim", { token: setup.nodeToken })).status).toBe(204);

      // Alla minima il lavoro si consegna
      useManifest({ ...MANIFEST, minVersion: "0.1.0" });
      expect((await api("POST", "/node/turns/claim", { token: setup.nodeToken })).status).toBe(200);
      expect((await api("POST", "/node/claim", { token: setup.nodeToken })).status).toBe(200);
    } finally {
      turnPollSettings.waitMs = prevWait;
    }
  });
});

describe("stato di Claude", () => {
  it("si salva con claude_checked_at e si restituisce; i campi in più si scartano", async () => {
    const { id, token } = await newNode();
    const claude = { found: true, version: "2.1.0", loggedIn: true, authMethod: "claude.ai", subscriptionType: "team", loginExpiresAt: "2026-12-01T00:00:00Z", email: "ivan@example.com", orgId: "org-1" };
    const hb = await api("POST", "/node/heartbeat", { token, body: caps({ claude }) });
    expect(hb.status, hb.text).toBe(200);
    const row = await nodeRow(id);
    expect(row.claudeStatus).toEqual({ found: true, version: "2.1.0", loggedIn: true, authMethod: "claude.ai", subscriptionType: "team", loginExpiresAt: "2026-12-01T00:00:00Z" });
    expect(row.claudeCheckedAt).not.toBeNull();
    const view = await listed(id);
    expect(view.claude).toEqual(row.claudeStatus);
    expect(view.claudeCheckedAt).not.toBeNull();
    expect(JSON.stringify(view)).not.toContain("ivan@example.com");
  });
});

describe("stato di Claude malformato", () => {
  it("un campo strano non fa fallire l'heartbeat: 200 e si salvano solo i campi validi", async () => {
    const { id, token } = await newNode();
    const claude = { found: true, version: null, loginExpiresAt: 1763651609, loggedIn: "yes", authMethod: "x".repeat(300), email: "x@y", extra: { a: 1 } };
    const hb = await api("POST", "/node/heartbeat", { token, body: caps({ claude }) });
    expect(hb.status, hb.text).toBe(200);
    expect((await nodeRow(id)).claudeStatus).toEqual({ found: true, authMethod: "x".repeat(100), loginExpiresAt: "1763651609" });
  });
});

describe("impostazioni", () => {
  it("PUT salva e l'heartbeat le porta; null = default del nodo", async () => {
    const { id, token } = await newNode();
    const put = await api("PUT", `/account/nodes/${id}/settings`, { body: { maxConcurrent: 2, maxConcurrentTurns: null, taskTimeoutMinutes: 90 } });
    expect(put.status, put.text).toBe(200);
    expect(put.json.settings).toEqual({ maxConcurrent: 2, maxConcurrentTurns: null, taskTimeoutMinutes: 90 });
    const hb = await api("POST", "/node/heartbeat", { token, body: caps() });
    expect(hb.json).toEqual({ pending: 0, settings: { maxConcurrent: 2, maxConcurrentTurns: null, taskTimeoutMinutes: 90 } });
  });

  it("fuori intervallo, non interi o incompleti → 400 «impostazioni del nodo non valide»", async () => {
    const { id } = await newNode();
    const bodies = [
      { maxConcurrent: 4, maxConcurrentTurns: null, taskTimeoutMinutes: null },
      { maxConcurrent: 0, maxConcurrentTurns: null, taskTimeoutMinutes: null },
      { maxConcurrent: null, maxConcurrentTurns: 5, taskTimeoutMinutes: null },
      { maxConcurrent: null, maxConcurrentTurns: null, taskTimeoutMinutes: 4 },
      { maxConcurrent: null, maxConcurrentTurns: null, taskTimeoutMinutes: 241 },
      { maxConcurrent: 1.5, maxConcurrentTurns: null, taskTimeoutMinutes: null },
      { maxConcurrent: 1 },
    ];
    for (const body of bodies) {
      const res = await api("PUT", `/account/nodes/${id}/settings`, { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json).toEqual({ error: "impostazioni del nodo non valide" });
    }
    expect((await nodeRow(id)).settings).toBeNull();
  });
});

describe("diagnosi", () => {
  it("richiesta → heartbeat diagnosticsRequested; invio → 204, richiesta azzerata, scaricabile come testo", async () => {
    const { id, token } = await newNode();
    const req = await api("POST", `/account/nodes/${id}/diagnostics-request`);
    expect(req.status, req.text).toBe(200);
    expect(req.json.diagnosticsRequestedAt).not.toBeNull();
    expect((await api("POST", "/node/heartbeat", { token, body: caps() })).json).toEqual({ pending: 0, diagnosticsRequested: true });
    // Finché non arriva la diagnosi la richiesta resta
    expect((await api("POST", "/node/heartbeat", { token, body: caps() })).json.diagnosticsRequested).toBe(true);

    expect((await api("GET", `/account/nodes/${id}/diagnostics`)).status).toBe(404);
    const up = await api("POST", "/node/diagnostics", { token, body: { content: "riga uno\nriga due" } });
    expect(up.status, up.text).toBe(204);
    expect((await api("POST", "/node/heartbeat", { token, body: caps() })).json.diagnosticsRequested).toBeUndefined();

    const dl = await api("GET", `/account/nodes/${id}/diagnostics`);
    expect(dl.status).toBe(200);
    expect(dl.text).toBe("riga uno\nriga due");
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("content-type")).toContain("text/plain");
    expect((await listed(id)).diagnosticsAt).not.toBeNull();
    expect((await listed(id)).diagnosticsRequestedAt).toBeNull();

    // La nuova sostituisce la vecchia
    await api("POST", "/node/diagnostics", { token, body: { content: "nuova" } });
    expect((await api("GET", `/account/nodes/${id}/diagnostics`)).text).toBe("nuova");
    expect(await db.select().from(nodeDiagnosticsTable)).toHaveLength(1);
  });

  it("corpo oltre 256 KB → 413; senza content → 400", async () => {
    const { token } = await newNode();
    const big = await api("POST", "/node/diagnostics", { token, body: { content: "x".repeat(300 * 1024) } });
    expect(big.status).toBe(413);
    expect((await api("POST", "/node/diagnostics", { token, body: {} })).status).toBe(400);
  });

  it("la 7ª richiesta in un'ora → 429", async () => {
    const { id } = await newNode();
    for (let i = 0; i < 6; i++) expect((await api("POST", `/account/nodes/${id}/diagnostics-request`)).status).toBe(200);
    expect((await api("POST", `/account/nodes/${id}/diagnostics-request`)).status).toBe(429);
  });

  it("la pulizia toglie le diagnosi di oltre 7 giorni", async () => {
    const old = await newNode();
    const fresh = await newNode();
    await db.insert(nodeDiagnosticsTable).values([
      { nodeId: old.id, content: "vecchia", createdAt: new Date(Date.now() - 8 * 86_400_000) },
      { nodeId: fresh.id, content: "nuova" },
    ]);
    expect(await purgeNodeDiagnostics()).toBe(1);
    const rows = await db.select().from(nodeDiagnosticsTable);
    expect(rows.map((r) => r.nodeId)).toEqual([fresh.id]);
  });
});

describe("disinstallazione", () => {
  it("richiesta → heartbeat uninstallRequested; /node/uninstalled disattiva il nodo e il token vale 403", async () => {
    const { id, token } = await newNode();
    const req = await api("POST", `/account/nodes/${id}/uninstall-request`);
    expect(req.status, req.text).toBe(200);
    expect(req.json.uninstallRequestedAt).not.toBeNull();
    expect((await api("POST", "/node/heartbeat", { token, body: caps() })).json).toEqual({ pending: 0, uninstallRequested: true });

    expect((await api("POST", "/node/uninstalled", { token })).status).toBe(204);
    expect((await nodeRow(id)).status).toBe("disabled");
    expect((await api("POST", "/node/heartbeat", { token, body: caps() })).status).toBe(403);
  });
});

describe("route d'account: accesso", () => {
  it("nodo altrui → 404 «nodo non trovato» su tutte; token personale → 403", async () => {
    const mine = await newNode();
    const theirs = await newNode("Altrui", otherUserId);
    const calls: [string, string, unknown?][] = [
      ["PUT", `/account/nodes/${theirs.id}/settings`, { maxConcurrent: 1, maxConcurrentTurns: null, taskTimeoutMinutes: null }],
      ["POST", `/account/nodes/${theirs.id}/diagnostics-request`],
      ["GET", `/account/nodes/${theirs.id}/diagnostics`],
      ["POST", `/account/nodes/${theirs.id}/uninstall-request`],
    ];
    for (const [method, path, body] of calls) {
      const res = await api(method, path, { body });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.json).toEqual({ error: "nodo non trovato" });
    }
    const { token } = await createApiToken(userId, "Script", 30, ["api:write"]);
    for (const [method, path, body] of [
      ["PUT", `/account/nodes/${mine.id}/settings`, { maxConcurrent: 1, maxConcurrentTurns: null, taskTimeoutMinutes: null }],
      ["POST", `/account/nodes/${mine.id}/diagnostics-request`],
      ["GET", `/account/nodes/${mine.id}/diagnostics`],
      ["POST", `/account/nodes/${mine.id}/uninstall-request`],
      ["GET", "/account/nodes/download"],
    ] as [string, string, unknown?][]) {
      const res = await api(method, path, { token, body });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("le route del nodo rifiutano la sessione (403)", async () => {
    expect((await api("POST", "/node/diagnostics", { body: { content: "x" } })).status).toBe(403);
    expect((await api("POST", "/node/uninstalled")).status).toBe(403);
  });
});

describe("scarico del pacchetto", () => {
  it("senza manifest available false; con manifest l'indirizzo dello zip", async () => {
    expect((await api("GET", "/account/nodes/download")).json).toEqual({ available: false, version: null, url: null, size: null });
    useManifest(MANIFEST);
    expect((await api("GET", "/account/nodes/download")).json).toEqual({
      available: true,
      version: "0.3.0",
      url: "/downloads/nodo/Botcave-Nodo-0.3.0.zip",
      size: 99,
    });
  });
});

describe("Dashboard", () => {
  it("nodi collegati nelle ultime 24 ore (solo attivi e dell'utente)", async () => {
    const recent = await newNode("Recente");
    const old = await newNode("Vecchio");
    const off = await newNode("Spento");
    const theirs = await newNode("Altrui", otherUserId);
    await db.update(nodesTable).set({ pairedAt: new Date(Date.now() - 3600_000) }).where(eq(nodesTable.id, recent.id));
    await db.update(nodesTable).set({ pairedAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(nodesTable.id, old.id));
    await db.update(nodesTable).set({ pairedAt: new Date(Date.now() - 3600_000), status: "disabled" }).where(eq(nodesTable.id, off.id));
    await db.update(nodesTable).set({ pairedAt: new Date(Date.now() - 3600_000) }).where(eq(nodesTable.id, theirs.id));
    const stats = await api("GET", "/dashboard/stats");
    expect(stats.status, stats.text).toBe(200);
    expect(stats.json.recentlyPairedNodes).toEqual([{ id: recent.id, name: "Recente", pairedAt: expect.any(String) }]);
    expect(stats.json.nodeClaudeWarnings).toEqual([]);
  });

  it("avvisi di Claude solo per i nodi con un account «Claude Code (nodo)» dell'utente", async () => {
    const setup = await seedNodeTurnSetup("dev@localhost", "Con account");
    const noAccount = await newNode("Senza account");
    await db.update(nodesTable).set({ claudeStatus: { found: true, loggedIn: false } }).where(eq(nodesTable.id, setup.nodeId));
    await db.update(nodesTable).set({ claudeStatus: { found: true, loggedIn: false } }).where(eq(nodesTable.id, noAccount.id));
    const reasons = async () => (await api("GET", "/dashboard/stats")).json.nodeClaudeWarnings;
    expect(await reasons()).toEqual([{ nodeId: setup.nodeId, nodeName: "Con account", reason: "not_logged_in" }]);

    await db.update(nodesTable).set({ claudeStatus: { found: false } }).where(eq(nodesTable.id, setup.nodeId));
    expect((await reasons())[0].reason).toBe("not_installed");

    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await db.update(nodesTable).set({ claudeStatus: { found: true, loggedIn: true, loginExpiresAt: soon } }).where(eq(nodesTable.id, setup.nodeId));
    expect((await reasons())[0].reason).toBe("login_expiring");

    const later = new Date(Date.now() + 20 * 86_400_000).toISOString();
    await db.update(nodesTable).set({ claudeStatus: { found: true, loggedIn: true, loginExpiresAt: later } }).where(eq(nodesTable.id, setup.nodeId));
    expect(await reasons()).toEqual([]);

    // Claude trovato ma accesso non noto (loggedIn assente): nessun avviso
    await db.update(nodesTable).set({ claudeStatus: { found: true, version: "2.1.0" } }).where(eq(nodesTable.id, setup.nodeId));
    expect(await reasons()).toEqual([]);

    // Nessun dato di Claude ancora: nessun avviso
    await db.update(nodesTable).set({ claudeStatus: null }).where(eq(nodesTable.id, setup.nodeId));
    expect(await reasons()).toEqual([]);
  });
});

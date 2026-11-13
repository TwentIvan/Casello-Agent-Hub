import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { appsTable, db, githubInstallationsTable, pool } from "@workspace/db";
import { catalogSkill, ensureUser, nodeRole, seedNodeTeam } from "../../test/team-node-fixture";
import { startFakeGithub, type FakeGithub } from "../../test/fake-github";
import { clearInstallationTokenCache } from "../lib/github/app";
import { startTask } from "../lib/teams/task-runner";

// POST /api/node/tasks/:id/git-token sull'app completa (porta 0) con il finto GitHub. Il logger scrive in memoria
// per verificare che il token non finisca nei log.

const logLines = vi.hoisted(() => [] as string[]);

vi.mock("../lib/logger", async () => {
  const { default: pino } = await import("pino");
  const actual = await vi.importActual<typeof import("../lib/logger")>("../lib/logger");
  const logger = pino({ level: "trace", redact: actual.LOG_REDACT_PATHS }, { write: (line: string) => void logLines.push(line) });
  return { ...actual, logger };
});

const REPO = "ivan/mister";
const LEASE_MSG = "lease non valida o scaduta";
const ACCESS_MSG = "accesso al repository non disponibile";
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let gh: FakeGithub;
let createNode: typeof import("../lib/nodes/nodes").createNode;
let userId: number;
let otherUserId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; text: string; json: any; headers: Headers }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.includes("application/json") ?? false;
  return { status: res.status, text, json: isJson && text ? JSON.parse(text) : undefined, headers: res.headers };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  gh = await startFakeGithub();
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost,altro@example.com",
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
  ({ createNode } = await import("../lib/nodes/nodes"));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await gh.close();
  await pool.query("TRUNCATE users, apps, skills, team_instances RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  // senza RESTART IDENTITY: il limite per compito è in memoria per id
  await pool.query("TRUNCATE users, apps, skills, team_instances CASCADE");
  clearInstallationTokenCache();
  logLines.length = 0;
  gh.requests.length = 0;
  gh.failWith = null;
  userId = await ensureUser("dev@localhost");
  otherUserId = await ensureUser("altro@example.com");
  await catalogSkill("sap-abap", "node", "sap:abap-developer");
  gh.addInstallation({ id: 7, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(7, { contents: "write", metadata: "read" });
});

/** Compito preso dal nodo (lease valida). `owner` = chi possiede l'installazione 7 in Botcave. */
async function claimed(opts: { code?: "write" | "none"; withRepo?: boolean; owner?: number | null } = {}) {
  const role = nodeRole({ skills: [{ code: "sap-abap", version: 1 }], code: opts.code ?? "write" });
  const instanceId = await seedNodeTeam({ userId, roles: [role] });
  if (opts.withRepo !== false) {
    await db.update(appsTable).set({ sourceType: "github", sourceRepo: REPO, sourceInstallationId: 7, sourceBranch: "main" }).where(eq(appsTable.slug, "hub-up"));
  }
  const owner = opts.owner === undefined ? userId : opts.owner;
  if (owner !== null) {
    await db.insert(githubInstallationsTable).values({ userId: owner, installationId: 7, accountLogin: "ivan", accountType: "User", repositorySelection: "all" });
  }
  const started = await startTask(instanceId, "t1");
  const { node, token } = await createNode(userId, "Mac");
  const hb = await api("POST", "/node/heartbeat", {
    token,
    body: { version: "0.4.0", executor: "claude-code", skills: ["sap:abap-developer"], workspaceRoot: "/w", maxConcurrent: 1, git: { found: true, version: "2.39.5" } },
  });
  expect(hb.status, hb.text).toBe(200);
  const claim = await api("POST", "/node/claim", { token });
  expect(claim.status, claim.text).toBe(200);
  return { nodeId: node.id, token, taskId: started.id, leaseToken: claim.json.leaseToken as string };
}

describe("POST /node/tasks/:id/git-token", () => {
  it("con lease valida: token del finto GitHub ristretto al repository con contents write, no-store", async () => {
    const { token, taskId, leaseToken } = await claimed();
    const res = await api("POST", `/node/tasks/${taskId}/git-token`, { token, body: { leaseToken } });
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const issued = gh.issuedTokens.get(res.json.token);
    expect(issued).toBeDefined();
    expect(issued!.permissions).toEqual({ contents: "write" });
    expect(issued!.repositories).toEqual([REPO]);
    expect(new Date(res.json.expiresAt).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
  });

  it("lease sbagliata → 409", async () => {
    const { token, taskId } = await claimed();
    const res = await api("POST", `/node/tasks/${taskId}/git-token`, { token, body: { leaseToken: "sbagliata" } });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(LEASE_MSG);
  });

  it("ruolo senza codice → 409 accesso non disponibile", async () => {
    const { token, taskId, leaseToken } = await claimed({ code: "none" });
    const res = await api("POST", `/node/tasks/${taskId}/git-token`, { token, body: { leaseToken } });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(ACCESS_MSG);
  });

  it("App senza installazione → 409 accesso non disponibile", async () => {
    const { token, taskId, leaseToken } = await claimed({ withRepo: false });
    const res = await api("POST", `/node/tasks/${taskId}/git-token`, { token, body: { leaseToken } });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(ACCESS_MSG);
  });

  it("installazione di un altro utente → 409 accesso non disponibile", async () => {
    const { token, taskId, leaseToken } = await claimed({ owner: otherUserId });
    const res = await api("POST", `/node/tasks/${taskId}/git-token`, { token, body: { leaseToken } });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(ACCESS_MSG);
  });

  it("errore di GitHub → 502 col messaggio fisso", async () => {
    const { token, taskId, leaseToken } = await claimed();
    gh.failWith = () => 500;
    const res = await api("POST", `/node/tasks/${taskId}/git-token`, { token, body: { leaseToken } });
    expect(res.status).toBe(502);
    expect(typeof res.json.error).toBe("string");
  });

  it("l'undicesima richiesta in un minuto → 429", async () => {
    const { token, taskId, leaseToken } = await claimed();
    for (let i = 0; i < 10; i++) expect((await api("POST", `/node/tasks/${taskId}/git-token`, { token, body: { leaseToken } })).status).toBe(200);
    expect((await api("POST", `/node/tasks/${taskId}/git-token`, { token, body: { leaseToken } })).status).toBe(429);
  });

  it("il token non compare nei log", async () => {
    const { token, taskId, leaseToken } = await claimed();
    const res = await api("POST", `/node/tasks/${taskId}/git-token`, { token, body: { leaseToken } });
    expect(res.status).toBe(200);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.some((l) => l.includes(res.json.token))).toBe(false);
    expect(logLines.some((l) => l.includes(leaseToken))).toBe(false);
  });
});

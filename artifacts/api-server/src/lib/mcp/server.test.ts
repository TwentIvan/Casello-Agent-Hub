import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db, pool, analysesTable, analysisItemsTable, appsTable, usersTable } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { createApiToken, revokeApiToken } from "../api-tokens";
import { clearInstallationTokenCache } from "../github/app";
import type { GithubConfig } from "../github/config";
import { LOCAL_MODEL } from "../architect/local-executor";
import { recordPhaseResult } from "../architect/phase-record";
import { PHASE_EXAMPLES } from "../architect/prompts";
import { PHASES, PHASE_SCHEMAS } from "../architect/schemas";
import { mcpRouter, type McpRouterOptions } from "./server";

// Server MCP su un'app Express vera (porta 0) con il client MCP dello stesso SDK. GitHub è finto
// (token di installazione e sha del branch); l'app analizzata espone un OpenAPI su un server locale.

const realFetch = globalThis.fetch;
const savedAllowed = process.env.ALLOWED_EMAILS;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const TOOL_NAMES = [
  "abandon_analysis",
  "claim_analysis",
  "get_phase_instructions",
  "list_analyses",
  "ping_analysis",
  "read_openapi",
  "submit_phase",
];

const OPENAPI = {
  openapi: "3.0.0",
  info: { title: "Fanta", version: "1" },
  paths: {
    "/api/teams": {
      get: { operationId: "listTeams", summary: "Elenco delle squadre", responses: { "200": { description: "ok" } } },
      post: { operationId: "createTeam", summary: "Nuova squadra", responses: { "201": { description: "creata" } } },
    },
    "/api/players": { get: { operationId: "listPlayers", responses: { "200": { description: "ok" } } } },
  },
};

let gh: FakeGithub;
let cfg: GithubConfig;
let openapiServer: http.Server;
let appBase: string;
const servers: http.Server[] = [];

let userId: number;
let token: string;
let tokenId: number;
let otherToken: string;
let appId: number;
let analysisId: number;

/** Tutti i testi ricevuti dal server MCP nel test corrente (per cercare segreti). */
let seen: string[] = [];

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

/** App Express con il solo router MCP, su una porta libera. */
async function startMcp(opts: McpRouterOptions = {}): Promise<string> {
  const app = express();
  app.use("/mcp", mcpRouter({ sources: { githubConfig: cfg }, ...opts }));
  const server = http.createServer(app);
  servers.push(server);
  return `${await listen(server)}/mcp`;
}

async function connect(url: string, bearer: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return client;
}

interface ToolText {
  isError: boolean;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolText> {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  expect(res.content).toHaveLength(1);
  expect(res.content[0]!.type).toBe("text");
  const text = res.content[0]!.text!;
  seen.push(text);
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // non JSON: il test che lo attende lo controlla
  }
  return { isError: res.isError === true, text, json };
}

/** POST JSON-RPC grezzo su /mcp. */
async function rawPost(url: string, bearer: string | null, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (bearer !== null) headers["authorization"] = `Bearer ${bearer}`;
  const res = await realFetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  seen.push(text);
  return { status: res.status, text, headers: res.headers };
}

async function newLocalAnalysis(): Promise<number> {
  const [row] = await db
    .insert(analysesTable)
    .values({
      appId,
      model: LOCAL_MODEL,
      aiModelId: null,
      executor: "local",
      sources: { code: "github", openapi: false, description: true },
      maxTokens: 1_000_000,
    })
    .returning();
  return row!.id;
}

beforeAll(async () => {
  process.env.ALLOWED_EMAILS = "ivan@example.com,altro@example.com";
  gh = await startFakeGithub();
  cfg = {
    appId: gh.appId,
    slug: gh.slug,
    clientId: gh.clientId,
    clientSecret: gh.clientSecret,
    privateKey: gh.privateKeyPem,
    apiBase: gh.apiBase,
    webBase: gh.webBase,
  };
  openapiServer = http.createServer((req, res) => {
    if (req.url === "/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(OPENAPI));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  appBase = await listen(openapiServer);
});

afterAll(async () => {
  for (const s of [...servers, openapiServer]) {
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await gh.close();
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  if (savedAllowed === undefined) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = savedAllowed;
});

beforeEach(async () => {
  seen = [];
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  clearInstallationTokenCache();
  gh.installations.clear();
  gh.repos.clear();
  gh.revoked.clear();
  gh.issuedTokens.clear();
  gh.commits.clear();
  gh.requests.length = 0;
  gh.addInstallation({ id: 11, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" }, [
    { fullName: "ivan/fanta", defaultBranch: "main", private: true },
  ]);
  gh.commits.set("ivan/fanta", SHA);

  const [user] = await db.insert(usersTable).values({ email: "ivan@example.com" }).returning();
  userId = user!.id;
  const created = await createApiToken(userId, "Mac", 30);
  token = created.token;
  tokenId = created.row.id;
  const [other] = await db.insert(usersTable).values({ email: "altro@example.com" }).returning();
  otherToken = (await createApiToken(other!.id, "Altro", 30)).token;

  const [app] = await db
    .insert(appsTable)
    .values({
      name: "Fanta",
      slug: "fanta-mcp",
      baseUrl: appBase,
      functionalDescription: "Gestione del fantacalcio",
      sourceType: "github",
      sourceRepo: "ivan/fanta",
      sourceBranch: "main",
      sourceInstallationId: 11,
    })
    .returning();
  appId = app!.id;
  analysisId = await newLocalAnalysis();
});

/** Nessun testo ricevuto contiene un token personale o un token GitHub. */
function expectNoSecrets() {
  const all = seen.join("\n");
  expect(all).not.toContain("cas_");
  expect(all).not.toContain("ghs_");
  for (const t of gh.issuedTokens.keys()) expect(all).not.toContain(t);
}

describe("autenticazione", () => {
  it("senza token, con token sconosciuto o revocato → 401 con il messaggio fisso", async () => {
    const url = await startMcp();
    for (const bearer of [null, "cas_inesistente", "non-un-token"]) {
      const res = await rawPost(url, bearer);
      expect(res.status).toBe(401);
      expect(JSON.parse(res.text)).toEqual({ error: "token non valido o scaduto" });
    }
    expect((await rawPost(url, token)).status).not.toBe(401);
    await revokeApiToken(userId, tokenId);
    const revoked = await rawPost(url, token);
    expect(revoked.status).toBe(401);
    expect(JSON.parse(revoked.text)).toEqual({ error: "token non valido o scaduto" });
    await expect(connect(url, token)).rejects.toThrow();
  });

  it("GET e DELETE → 405 JSON (server senza sessioni)", async () => {
    const url = await startMcp();
    for (const method of ["GET", "DELETE"]) {
      const res = await realFetch(url, { method, headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(405);
      expect(res.headers.get("content-type")).toMatch(/json/);
    }
  });
});

describe("strumenti", () => {
  it("listTools elenca i sette strumenti con le descrizioni", async () => {
    const client = await connect(await startMcp(), token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    for (const t of tools) expect(t.description).toBeTruthy();
    const claim = tools.find((t) => t.name === "claim_analysis")!;
    expect(claim.inputSchema.required).toEqual(expect.arrayContaining(["analysisId", "label"]));
    await client.close();
  });

  it("percorso completo: list → claim → istruzioni → OpenAPI → sei consegne → completed, come un'analisi cloud", async () => {
    const client = await connect(await startMcp(), token);

    const list = await call(client, "list_analyses");
    expect(list.isError).toBe(false);
    expect(list.json.analyses).toEqual([
      expect.objectContaining({ analysisId, appName: "Fanta", status: "queued", deliveredPhases: [], leaseLabel: null }),
    ]);

    const claim = await call(client, "claim_analysis", { analysisId, label: "Mac di Ivan" });
    expect(claim.isError).toBe(false);
    expect(claim.json).toMatchObject({
      analysisId,
      phase: "map",
      expectedCommit: SHA,
      app: { name: "Fanta", baseUrl: appBase, sourceRepo: "ivan/fanta", sourceBranch: "main", hasOpenApi: true },
    });
    const leaseToken: string = claim.json.leaseToken;
    expect(leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Lo sha si chiede a GitHub con il token di installazione ristretto al repo
    const shaReq = gh.requests.find((r) => r.path === "/repos/ivan/fanta/commits/main");
    expect(shaReq?.auth).toMatch(/^Bearer ghs_/);

    const instr = await call(client, "get_phase_instructions", { analysisId, leaseToken });
    expect(instr.isError).toBe(false);
    expect(instr.json.phase).toBe("map");
    expect(instr.json.system).toMatch(/read_openapi/);
    expect(instr.json.user).toMatch(/list_operations/);

    const ops = await call(client, "read_openapi", { analysisId, leaseToken, prefix: "/api/teams" });
    expect(ops.isError).toBe(false);
    expect(ops.json.hasOpenApi).toBe(true);
    expect(ops.json.content).toContain("GET /api/teams — listTeams — Elenco delle squadre");
    expect(ops.json.content).not.toContain("/api/players");
    const op = await call(client, "read_openapi", { analysisId, leaseToken, method: "post", path: "/api/teams" });
    expect(op.json.content).toContain("createTeam");

    const ping = await call(client, "ping_analysis", { analysisId, leaseToken });
    expect(ping.isError).toBe(false);
    expect(ping.json.leaseUntil).toEqual(expect.any(String));

    let last: ToolText | null = null;
    for (const [i, phase] of PHASES.entries()) {
      last = await call(client, "submit_phase", { analysisId, leaseToken, phase, result: PHASE_EXAMPLES[phase], sourceCommit: SHA });
      expect(last.isError, phase).toBe(false);
      expect(last.json.ok, last.text).toBe(true);
      expect(last.json.nextPhase).toBe(PHASES[i + 1] ?? null);
    }
    const [row] = await db.select().from(analysesTable).where(eq(analysesTable.id, analysisId));
    expect(row!.status).toBe("completed");
    expect(row!.sourceCommit).toBe(SHA);
    // Commit uguale a quello atteso: nessuna nota nel log
    expect(row!.log.some((e) => /atteso/.test(e.message))).toBe(false);

    // Stessi esiti registrati come nel percorso cloud: stesso numero di elementi per capitolo
    const cloudId = (
      await db
        .insert(analysesTable)
        .values({ appId, model: "openrouter/auto", sources: { code: "none", openapi: false, description: true }, maxTokens: 1000 })
        .returning()
    )[0]!.id;
    for (const phase of PHASES) {
      await recordPhaseResult({ analysisId: cloudId, appId, phase, result: PHASE_SCHEMAS[phase].parse(PHASE_EXAMPLES[phase]) });
    }
    const counts = async (id: number) => {
      const items = await db.select().from(analysisItemsTable).where(eq(analysisItemsTable.analysisId, id));
      const out: Record<string, number> = {};
      for (const it of items) out[it.chapter] = (out[it.chapter] ?? 0) + 1;
      return out;
    };
    const local = await counts(analysisId);
    expect(Object.keys(local).length).toBeGreaterThan(0);
    expect(local).toEqual(await counts(cloudId));
    expect(last!.json.summary).toMatchObject(local);

    // Analisi chiusa: non è più in elenco
    expect((await call(client, "list_analyses")).json.analyses).toEqual([]);
    expectNoSecrets();
    await client.close();
  });

  it("commit diverso da quello atteso: annotato nel log, la consegna passa", async () => {
    const client = await connect(await startMcp(), token);
    const { leaseToken } = (await call(client, "claim_analysis", { analysisId, label: "Mac" })).json;
    const res = await call(client, "submit_phase", { analysisId, leaseToken, phase: "map", result: PHASE_EXAMPLES.map, sourceCommit: "fedcba9" });
    expect(res.json.ok).toBe(true);
    const [row] = await db.select().from(analysesTable).where(eq(analysesTable.id, analysisId));
    expect(row!.log.some((e) => e.message === `analizzato il commit fedcba9, atteso ${SHA}`)).toBe(true);
    await client.close();
  });

  it("app senza OpenAPI né App GitHub: hasOpenApi false, expectedCommit null, read_openapi lo dice", async () => {
    await db.update(appsTable).set({ baseUrl: "http://127.0.0.1:1", sourceInstallationId: null }).where(eq(appsTable.id, appId));
    const client = await connect(await startMcp(), token);
    const claim = await call(client, "claim_analysis", { analysisId, label: "Mac" });
    expect(claim.json.app.hasOpenApi).toBe(false);
    expect(claim.json.expectedCommit).toBeNull();
    expect(gh.requests.some((r) => r.path.includes("/commits/"))).toBe(false);
    const ops = await call(client, "read_openapi", { analysisId, leaseToken: claim.json.leaseToken });
    expect(ops.isError).toBe(false);
    expect(ops.json.hasOpenApi).toBe(false);
    await client.close();
  });

  it("GitHub che non risponde: expectedCommit null, il claim riesce", async () => {
    gh.failWith = (r) => (r.path.includes("/commits/") ? 500 : null);
    try {
      const client = await connect(await startMcp(), token);
      const claim = await call(client, "claim_analysis", { analysisId, label: "Mac" });
      expect(claim.isError).toBe(false);
      expect(claim.json.expectedCommit).toBeNull();
      await client.close();
    } finally {
      gh.failWith = null;
    }
  });

  it("esito non valido: isError assente, ok false con le issues; la fase non avanza", async () => {
    const client = await connect(await startMcp(), token);
    const { leaseToken } = (await call(client, "claim_analysis", { analysisId, label: "Mac" })).json;
    const res = await call(client, "submit_phase", { analysisId, leaseToken, phase: "map", result: { stack: "non un elenco" } });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ ok: false, error: "esito non valido" });
    expect(res.json.issues.length).toBeGreaterThan(0);
    const [row] = await db.select().from(analysesTable).where(eq(analysesTable.id, analysisId));
    expect(row!.phase).toBe("map");
    await client.close();
  });

  it("errori dell'esecutore locale: isError con il solo messaggio fisso", async () => {
    const client = await connect(await startMcp(), token);
    const notFound = await call(client, "claim_analysis", { analysisId: 9999, label: "Mac" });
    expect(notFound.isError).toBe(true);
    expect(notFound.json).toEqual({ error: "analisi non trovata o non tua" });

    const { leaseToken } = (await call(client, "claim_analysis", { analysisId, label: "Mac" })).json;
    const wrongLease = await call(client, "get_phase_instructions", { analysisId, leaseToken: "sbagliato" });
    expect(wrongLease.isError).toBe(true);
    expect(wrongLease.json).toEqual({ error: "lease scaduta: chiedi di nuovo il compito" });

    const wrongPhase = await call(client, "submit_phase", { analysisId, leaseToken, phase: "catalog", result: PHASE_EXAMPLES.catalog });
    expect(wrongPhase.isError).toBe(true);
    expect(wrongPhase.json).toEqual({ error: "fase attesa: map" });

    const openapiWrongLease = await call(client, "read_openapi", { analysisId, leaseToken: "sbagliato" });
    expect(openapiWrongLease.json).toEqual({ error: "lease scaduta: chiedi di nuovo il compito" });

    const abandoned = await call(client, "abandon_analysis", { analysisId, leaseToken, reason: "repository non clonabile" });
    expect(abandoned.isError).toBe(false);
    expect(abandoned.json).toEqual({ ok: true });
    const [row] = await db.select().from(analysesTable).where(eq(analysesTable.id, analysisId));
    expect(row!.status).toBe("failed");
    expectNoSecrets();
    await client.close();
  });
});

describe("rate limit", () => {
  it("61 chiamate in un minuto con lo stesso token: l'ultima 429; un altro utente passa", async () => {
    const url = await startMcp({ sources: { githubConfig: null } });
    for (let i = 0; i < 60; i++) expect((await rawPost(url, token)).status, `chiamata ${i + 1}`).not.toBe(429);
    const blocked = await rawPost(url, token);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect((await rawPost(url, otherToken)).status).not.toBe(429);
  });

  it("limite iniettabile: chiave per utente, non per IP", async () => {
    const url = await startMcp({ rateLimit: { limit: 2, windowMs: 60_000 } });
    expect((await rawPost(url, token)).status).not.toBe(429);
    expect((await rawPost(url, token)).status).not.toBe(429);
    expect((await rawPost(url, token)).status).toBe(429);
    // Stesso IP, altro utente: contatore suo
    expect((await rawPost(url, otherToken)).status).not.toBe(429);
  });
});

describe("montaggio nell'app", () => {
  it("/mcp risponde fuori da /api, senza cookie di sessione né CORS", async () => {
    // Senza login configurato l'app si carica solo con AUTH_DISABLED (utente di sviluppo su /api)
    const savedAuth = process.env["AUTH_DISABLED"];
    process.env["AUTH_DISABLED"] = "true";
    let app: typeof import("../../app").default;
    try {
      ({ default: app } = await import("../../app"));
    } finally {
      if (savedAuth === undefined) delete process.env["AUTH_DISABLED"];
      else process.env["AUTH_DISABLED"] = savedAuth;
    }
    const server = http.createServer(app);
    servers.push(server);
    const url = `${await listen(server)}/mcp`;
    const res = await realFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "token non valido o scaduto" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await realFetch(url, { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const client = await connect(url, token);
    expect((await client.listTools()).tools).toHaveLength(7);
    await client.close();
  });
});

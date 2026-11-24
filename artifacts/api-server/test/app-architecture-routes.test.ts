import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  appArchitectureRunsTable,
  appArchitectureTable,
  appsTable,
  usersTable,
} from "@workspace/db";
import { allowTestLoopback } from "./fake-provider";
import { encryptSecret } from "../src/lib/secrets";
import type { TokenScope } from "../src/lib/api-tokens";
import { ARCH_MESSAGES } from "../src/lib/architecture/messages";
import { waitArchitectureIdleForTests } from "../src/lib/architecture/service";
import { resetArchitectureRefreshLimit } from "../src/middlewares/rate-limit";

// Route della sintesi dell'architettura sull'app completa (porta 0), con AUTH_DISABLED=true: senza header la
// richiesta è l'utente di sviluppo; con un token vale solo il token.

const DEV_EMAIL = "dev@localhost";
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let createApiToken: typeof import("../src/lib/api-tokens").createApiToken;
let userId: number;
let appId: number;
let modelId: number;
let restoreLoopback: () => void;

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

/** Rende l'App idonea: GitHub tramite installazione e Responsabile con un modello. */
async function makeEligible() {
  await db.update(appsTable).set({ sourceType: "github", sourceRepo: "ivan/fanta", sourceInstallationId: 11 }).where(eqId());
  await db.insert(agentsTable).values({ appId, name: "Responsabile", role: "general", status: "active", aiModelId: modelId });
}
function eqId() {
  return eq(appsTable.id, appId);
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: DEV_EMAIL, CASELLO_SECRET_KEY: "a".repeat(64) });
  restoreLoopback = allowTestLoopback();
  const { ensureProviderRegistry } = await import("../src/lib/catalog/provider-registry");
  await ensureProviderRegistry();
  const { default: app } = await import("../src/app");
  ({ createApiToken } = await import("../src/lib/api-tokens"));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await waitArchitectureIdleForTests();
  restoreLoopback();
  await pool.query("TRUNCATE apps, ai_accounts, users CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await waitArchitectureIdleForTests();
  resetArchitectureRefreshLimit();
  await pool.query("TRUNCATE apps, ai_accounts, users CASCADE");
  const [user] = await db.insert(usersTable).values({ email: DEV_EMAIL, name: "Dev" }).returning();
  userId = user!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: "http://127.0.0.1:1", allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-prova"), status: "ok" })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake" })
    .returning();
  modelId = model!.id;
  const [app] = await db.insert(appsTable).values({ name: "Fanta", slug: "fanta", baseUrl: "http://fanta.example" }).returning();
  appId = app!.id;
});

describe("GET /apps/:id/architecture", () => {
  it("App senza GitHub: non disponibile, con il motivo", async () => {
    const r = await api("GET", `/apps/${appId}/architecture`);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({
      appId,
      refresh: "6h",
      available: false,
      unavailableReason: ARCH_MESSAGES.noGithub,
      status: "idle",
      sha: null,
      summary: null,
      costUsd: null,
      aiModelName: null,
    });
  });

  it("App inesistente: 404", async () => {
    expect((await api("GET", "/apps/99999/architecture")).status).toBe(404);
  });

  it("con una sintesi: campi, costo come numero e nome del modello", async () => {
    await makeEligible();
    await db.insert(appArchitectureTable).values({
      appId,
      sha: "a".repeat(40),
      branch: "main",
      summary: "## Sintesi\ntesto",
      repoMap: "src/index.ts",
      status: "idle",
      generatedAt: new Date("2026-11-16T10:00:00Z"),
      checkedAt: new Date("2026-11-16T11:00:00Z"),
      aiModelId: modelId,
      promptTokens: 1000,
      completionTokens: 500,
      costUsd: "0.002",
    });
    const r = await api("GET", `/apps/${appId}/architecture`);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({
      available: true,
      unavailableReason: null,
      sha: "a".repeat(40),
      branch: "main",
      summary: "## Sintesi\ntesto",
      repoMap: "src/index.ts",
      promptTokens: 1000,
      completionTokens: 500,
      costUsd: 0.002,
      aiModelName: "Fake",
      generatedAt: "2026-11-16T10:00:00.000Z",
    });
  });
});

describe("versioni", () => {
  it("elenco senza testo (solo con sintesi, dalla più recente), dettaglio con testo", async () => {
    const ins = (sha: string, summary: string | null, at: string) =>
      db
        .insert(appArchitectureRunsTable)
        .values({ appId, sha, summary, createdAt: new Date(at), costUsd: "0.01" })
        .returning();
    const [v1] = await ins("1".repeat(40), "testo uno", "2026-11-14T10:00:00Z");
    const [v2] = await ins("2".repeat(40), "testo due", "2026-11-15T10:00:00Z");
    await ins("3".repeat(40), null, "2026-11-16T10:00:00Z");

    const list = await api("GET", `/apps/${appId}/architecture/versions`);
    expect(list.status, list.text).toBe(200);
    expect(list.json.map((v: { id: number }) => v.id)).toEqual([v2!.id, v1!.id]);
    expect(list.json[0]).toMatchObject({ sha: "2".repeat(40), costUsd: 0.01 });
    expect(list.text).not.toContain("testo due");

    const one = await api("GET", `/apps/${appId}/architecture/versions/${v1!.id}`);
    expect(one.status, one.text).toBe(200);
    expect(one.json).toMatchObject({ id: v1!.id, summary: "testo uno" });
  });

  it("versione di un'altra App, senza testo o inesistente: 404 «versione non trovata»", async () => {
    const [other] = await db.insert(appsTable).values({ name: "Altra", slug: "altra", baseUrl: "http://altra.example" }).returning();
    const [foreign] = await db.insert(appArchitectureRunsTable).values({ appId: other!.id, sha: "f".repeat(40), summary: "x" }).returning();
    const [empty] = await db.insert(appArchitectureRunsTable).values({ appId, sha: "e".repeat(40), summary: null }).returning();
    for (const id of [foreign!.id, empty!.id, 99999]) {
      const r = await api("GET", `/apps/${appId}/architecture/versions/${id}`);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: "versione non trovata" });
    }
  });

  it("elenco: al più 20", async () => {
    for (let i = 0; i < 22; i++) {
      await db.insert(appArchitectureRunsTable).values({ appId, sha: String(i).padStart(40, "0"), summary: "s", createdAt: new Date(Date.UTC(2026, 10, 1, i)) });
    }
    const list = await api("GET", `/apps/${appId}/architecture/versions`);
    expect(list.json).toHaveLength(20);
  });
});

describe("POST /apps/:id/architecture/refresh", () => {
  it("App inesistente: 404", async () => {
    expect((await api("POST", "/apps/99999/architecture/refresh")).status).toBe(404);
  });

  it("App non idonea: 409 col motivo", async () => {
    const r = await api("POST", `/apps/${appId}/architecture/refresh`);
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: ARCH_MESSAGES.noGithub });
  });

  it("App idonea: 202 {queued: true}, poi 409 mentre è in corso", async () => {
    await makeEligible();
    const first = await api("POST", `/apps/${appId}/architecture/refresh`);
    expect(first.status, first.text).toBe(202);
    expect(first.json).toEqual({ queued: true });
    await waitArchitectureIdleForTests();
    await db.insert(appArchitectureTable).values({ appId, status: "running", startedAt: new Date() }).onConflictDoUpdate({
      target: appArchitectureTable.appId,
      set: { status: "running", startedAt: new Date() },
    });
    const second = await api("POST", `/apps/${appId}/architecture/refresh`);
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: ARCH_MESSAGES.running });
  });

  it("frequenza off: «Aggiorna ora» funziona lo stesso", async () => {
    await makeEligible();
    expect((await api("PATCH", `/apps/${appId}`, { body: { architectureRefresh: "off" } })).status).toBe(200);
    const r = await api("POST", `/apps/${appId}/architecture/refresh`);
    expect(r.status, r.text).toBe(202);
  });

  it("il 7° in un minuto: 429", async () => {
    for (let i = 0; i < 6; i++) expect((await api("POST", `/apps/${appId}/architecture/refresh`)).status).toBe(409);
    const r = await api("POST", `/apps/${appId}/architecture/refresh`);
    expect(r.status).toBe(429);
    expect(r.json).toEqual({ error: "Troppe richieste: riprova tra poco" });
  });

  it("token api:read: 403; api:write: ammesso", async () => {
    const read = await api("POST", `/apps/${appId}/architecture/refresh`, { token: await tokenWith(["api:read"]) });
    expect(read.status).toBe(403);
    const readGet = await api("GET", `/apps/${appId}/architecture`, { token: await tokenWith(["api:read"]) });
    expect(readGet.status).toBe(200);
    const write = await api("POST", `/apps/${appId}/architecture/refresh`, { token: await tokenWith(["api:write"]) });
    expect(write.status).toBe(409);
  });
});

describe("PATCH /apps/:id architectureRefresh", () => {
  it("salva la frequenza e l'App la espone", async () => {
    const r = await api("PATCH", `/apps/${appId}`, { body: { architectureRefresh: "off" } });
    expect(r.status, r.text).toBe(200);
    expect(r.json.architectureRefresh).toBe("off");
    expect((await api("GET", `/apps/${appId}`)).json.architectureRefresh).toBe("off");
    expect((await api("GET", `/apps/${appId}/architecture`)).json.refresh).toBe("off");
  });

  it("valore non valido: 400", async () => {
    expect((await api("PATCH", `/apps/${appId}`, { body: { architectureRefresh: "ogni-tanto" } })).status).toBe(400);
  });

  it("rianalisi automatica: spenta di default, si accende e l'App la espone", async () => {
    expect((await api("GET", `/apps/${appId}`)).json).toMatchObject({ autoReanalysis: false, reanalysisSeenSha: null, reanalysisCheckedAt: null });
    const r = await api("PATCH", `/apps/${appId}`, { body: { autoReanalysis: true } });
    expect(r.status, r.text).toBe(200);
    expect(r.json.autoReanalysis).toBe(true);
    expect((await api("PATCH", `/apps/${appId}`, { body: { autoReanalysis: "sì" } })).status).toBe(400);
  });

  it("token d'ambito agent: «Aggiorna ora» 403 (generazione a pagamento)", async () => {
    const r = await api("POST", `/apps/${appId}/architecture/refresh`, { token: await tokenWith(["agent"]) });
    expect(r.status).toBe(403);
  });

  it("token d'ambito agent: 403", async () => {
    const r = await api("PATCH", `/apps/${appId}`, { token: await tokenWith(["agent"]), body: { architectureRefresh: "off" } });
    expect(r.status).toBe(403);
  });
});

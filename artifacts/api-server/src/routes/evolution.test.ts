import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  analysisItemsTable,
  appArchitectureTable,
  appsTable,
  evolutionCyclesTable,
  githubInstallationsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/secrets";
import { CONSENT_VERSION } from "../lib/evolution/consent";

// L'analisi vera non parte: il giro si crea, ma nessun modello viene chiamato
vi.mock("../lib/architect/run-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/architect/run-analysis")>();
  return { ...orig, startAnalysis: vi.fn(async () => {}) };
});

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;
let resetRunNow: () => void;
let devId: number;
let modelId: number;
let appId: number;

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

function putBody(over: Record<string, unknown> = {}) {
  return {
    frequency: "weekly",
    itemsPerRound: 2,
    analysisAiModelId: modelId,
    teamTemplateId: null,
    mergeMode: "direct",
    stagingBranch: null,
    stagingUrl: null,
    monthlyBudgetUsd: 10,
    consent: { accepted: true, appSlug: "botcave", version: CONSENT_VERSION },
    ...over,
  };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["ALLOWED_EMAILS"] = "dev@localhost";
  process.env["CASELLO_SECRET_KEY"] = "e".repeat(64);
  const { default: app } = await import("../app");
  ({ createApiToken } = await import("../lib/api-tokens"));
  ({ resetEvolutionRunNowLimit: resetRunNow } = await import("../middlewares/rate-limit"));
  const { ensureProviderRegistry } = await import("../lib/catalog/provider-registry");
  await ensureProviderRegistry();
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users, apps, ai_accounts, github_installations RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  resetRunNow();
  await pool.query("TRUNCATE users, apps, ai_accounts, github_installations RESTART IDENTITY CASCADE");
  await api("GET", "/auth/me");
  const [dev] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  devId = dev!.id;
  await db.insert(githubInstallationsTable).values({ userId: devId, installationId: 11, accountLogin: "dev", accountType: "User", repositorySelection: "all" });
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: devId, name: "Account", provider: "custom", baseUrl: "https://llm.example.com/v1", apiKeyEnc: encryptSecret("sk-x"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "fake", displayName: "Fake" }).returning();
  modelId = model!.id;
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Botcave", slug: "botcave", baseUrl: "http://localhost:1", sourceType: "github", sourceRepo: "dev/botcave", sourceBranch: "main", sourceInstallationId: 11 })
    .returning();
  appId = app!.id;
  await db.insert(appArchitectureTable).values({ appId, summary: "## Sintesi\nTesto.", repoMap: "src/" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("API del ciclo di evoluzione", () => {
  it("get_senza_ciclo_risponde_null", async () => {
    const r = await api("GET", `/apps/${appId}/evolution`);
    expect(r.status).toBe(200);
    expect(r.json).toBeNull();
    expect((await api("GET", "/apps/9999/evolution")).status).toBe(404);
  });

  it("put_con_consenso_salva_e_get_e_coerente", async () => {
    const put = await api("PUT", `/apps/${appId}/evolution`, putBody());
    expect(put.status, put.text).toBe(200);
    expect(put.json).toMatchObject({
      appId,
      status: "active",
      frequency: "weekly",
      itemsPerRound: 2,
      analysisAiModelId: modelId,
      analysisModelName: "Fake",
      mergeMode: "direct",
      monthlyBudgetUsd: 10,
      spentUsd: 0,
      unpricedCount: 0,
      consentValid: true,
      openRound: null,
    });
    const get = await api("GET", `/apps/${appId}/evolution`);
    expect(get.json.consentValid).toBe(true);
    expect(get.json.activatedByName).toBe(put.json.activatedByName);
    // Senza consenso un ciclo nuovo non si crea
    await api("DELETE", `/apps/${appId}/evolution`).then(async (r) => {
      // attivo: va prima fermato
      expect(r.status).toBe(409);
    });
    const bad = await api("PUT", `/apps/${appId}/evolution`, putBody({ consent: undefined, itemsPerRound: 3 }));
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBeTypeOf("string");
  });

  it("consent_text_riporta_versione_e_righe", async () => {
    const r = await api("GET", `/apps/${appId}/evolution/consent-text?mergeMode=direct&analysisAiModelId=${modelId}&itemsPerRound=3&monthlyBudgetUsd=10`);
    expect(r.status, r.text).toBe(200);
    expect(r.json.version).toBe(CONSENT_VERSION);
    expect(r.json.lines.join("\n")).toContain("Botcave");
  });

  it("scritture_con_un_token_api_write_hanno_403_solo_login", async () => {
    const { token } = await createApiToken(devId, "Script", 30, ["api:read", "api:write"]);
    const r = await api("PUT", `/apps/${appId}/evolution`, putBody(), token);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("operazione disponibile solo con il login");
    expect((await api("GET", `/apps/${appId}/evolution`, undefined, token)).status).toBe(200);
  });

  it("il_token_agent_non_puo_fermare_riprendere_o_avviare", async () => {
    const { token } = await createApiToken(devId, "Agente", 30, ["agent"]);
    for (const p of ["stop", "resume", "run-now"]) {
      const r = await api("POST", `/apps/${appId}/evolution/${p}`, undefined, token);
      expect([p, r.status]).toEqual([p, 403]);
    }
    expect((await api("PUT", `/apps/${appId}/evolution`, putBody(), token)).status).toBe(403);
    expect((await api("DELETE", `/apps/${appId}/evolution`, undefined, token)).status).toBe(403);
  });

  it("run_now_la_terza_volta_in_un_ora_risponde_429", async () => {
    await api("PUT", `/apps/${appId}/evolution`, putBody());
    const first = await api("POST", `/apps/${appId}/evolution/run-now`);
    expect(first.status, first.text).toBe(202);
    expect(first.json).toMatchObject({ number: 1, status: "analyzing", itemIds: [] });
    const second = await api("POST", `/apps/${appId}/evolution/run-now`);
    expect(second.status).toBe(409);
    const third = await api("POST", `/apps/${appId}/evolution/run-now`);
    expect(third.status).toBe(429);
    expect(third.json.error).toBe("Troppe richieste: riprova tra poco");
    const view = await api("GET", `/apps/${appId}/evolution`);
    expect(view.json.openRound).toMatchObject({ number: 1, status: "analyzing" });
    const rounds = await api("GET", `/apps/${appId}/evolution/rounds`);
    expect(rounds.json).toHaveLength(1);
  });

  it("stop_resume_e_delete_seguono_le_regole_del_servizio", async () => {
    expect((await api("POST", `/apps/${appId}/evolution/stop`)).status).toBe(404);
    await api("PUT", `/apps/${appId}/evolution`, putBody());
    const stop = await api("POST", `/apps/${appId}/evolution/stop`);
    expect(stop.status, stop.text).toBe(200);
    expect(stop.json).toMatchObject({ status: "paused", pausedReason: "fermato dall'utente" });
    const resume = await api("POST", `/apps/${appId}/evolution/resume`);
    expect(resume.status, resume.text).toBe(200);
    expect(resume.json.status).toBe("active");
    expect((await api("DELETE", `/apps/${appId}/evolution`)).status).toBe(409);
    await api("POST", `/apps/${appId}/evolution/stop`);
    expect((await api("DELETE", `/apps/${appId}/evolution`)).status).toBe(204);
    expect((await api("GET", `/apps/${appId}/evolution`)).json).toBeNull();
  });

  it("dashboard_conta_i_cicli_in_pausa_attivati_dall_utente", async () => {
    await api("PUT", `/apps/${appId}/evolution`, putBody());
    expect((await api("GET", "/dashboard/stats")).json.evolutionCyclesPaused).toBe(0);
    await api("POST", `/apps/${appId}/evolution/stop`);
    expect((await api("GET", "/dashboard/stats")).json.evolutionCyclesPaused).toBe(1);
    // Un ciclo in pausa attivato da un altro utente non conta
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
    await db.update(evolutionCyclesTable).set({ activatedBy: other!.id });
    expect((await api("GET", "/dashboard/stats")).json.evolutionCyclesPaused).toBe(0);
  });

  it("le_voci_approvate_dal_ciclo_hanno_approvedByCycle", async () => {
    const [analysis] = await db.insert(analysesTable).values({ appId, model: "fake", status: "completed", maxTokens: 1000, sources: { code: "github", openapi: false, mcp: false, description: false } }).returning();
    const [a, b] = await db
      .insert(analysisItemsTable)
      .values([
        { analysisId: analysis!.id, chapter: "evolution", ref: "evolution:1", position: 0, payload: { title: "E1", priority: 1 }, diff: "new", status: "approved", approvedByCycle: true },
        { analysisId: analysis!.id, chapter: "evolution", ref: "evolution:2", position: 1, payload: { title: "E2", priority: 2 }, diff: "new", status: "approved" },
      ])
      .returning();
    const r = await api("GET", `/analyses/${analysis!.id}`);
    expect(r.status, r.text).toBe(200);
    const byId = new Map<number, { approvedByCycle: boolean }>(r.json.items.map((i: { id: number; approvedByCycle: boolean }) => [i.id, i]));
    expect(byId.get(a!.id)!.approvedByCycle).toBe(true);
    expect(byId.get(b!.id)!.approvedByCycle).toBe(false);
  });
});

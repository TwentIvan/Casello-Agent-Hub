import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, aiAccountsTable, aiModelsTable, appBootstrapsTable, appsTable, githubInstallationsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../lib/secrets";

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};
let base: string;
let server: http.Server;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;
let resetHealth: () => void;
let healthFetcher: { current: (u: string) => Promise<never> | Promise<unknown> };
let devId: number;
let modelId: number;

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

const createBody = (over: Record<string, unknown> = {}) => ({
  name: "Portfolio",
  slug: "portfolio",
  domain: "portfolio.fantamister.cloud",
  brief: "Un sito per i miei lavori.",
  repo: "dev/portfolio",
  installationId: 11,
  aiModelId: modelId,
  ...over,
});

async function insertRow(userId: number, over: Record<string, unknown> = {}) {
  const [r] = await db
    .insert(appBootstrapsTable)
    .values({ userId, slug: "portfolio", name: "Portfolio", domain: "portfolio.fantamister.cloud", repo: "dev/portfolio", installationId: 11, brief: "b", status: "done", ...over })
    .returning();
  return r!;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["ALLOWED_EMAILS"] = "dev@localhost";
  process.env["CASELLO_SECRET_KEY"] = "e".repeat(64);
  const { default: app } = await import("../app");
  ({ createApiToken } = await import("../lib/api-tokens"));
  ({ resetBootstrapHealthCheckLimit: resetHealth } = await import("../middlewares/rate-limit"));
  ({ healthFetcher } = (await import("./app-bootstraps")) as never);
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users, apps, ai_accounts, github_installations, app_bootstraps RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  resetHealth();
  await pool.query("TRUNCATE users, apps, ai_accounts, github_installations, app_bootstraps RESTART IDENTITY CASCADE");
  await api("GET", "/auth/me");
  const [dev] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  devId = dev!.id;
  await db
    .insert(githubInstallationsTable)
    .values({ userId: devId, installationId: 11, accountLogin: "dev", accountType: "User", repositorySelection: "all", userRepos: ["dev/portfolio"] });
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: devId, name: "Account", provider: "custom", baseUrl: "https://llm.example.com/v1", apiKeyEnc: encryptSecret("sk-x"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "fake", displayName: "Fake" }).returning();
  modelId = model!.id;
});

describe("API della nuova app da zero", () => {
  it("config_risponde_con_modello_e_dominio_di_base", async () => {
    const r = await api("GET", "/app-bootstraps/config");
    expect(r.status).toBe(200);
    expect(r.json.templateRepo).toContain("/");
    expect(r.json.baseDomain).toBeTruthy();
  });

  it("il_token_agent_non_puo_creare_riprovare_segnare_o_controllare", async () => {
    const { token } = await createApiToken(devId, "Agente", 30, ["agent"]);
    const row = await insertRow(devId, { status: "failed" });
    expect((await api("POST", "/app-bootstraps", createBody(), token)).status).toBe(403);
    expect((await api("POST", `/app-bootstraps/${row.id}/retry`, undefined, token)).status).toBe(403);
    expect((await api("PUT", `/app-bootstraps/${row.id}/checklist/neon`, { done: true }, token)).status).toBe(403);
    expect((await api("POST", `/app-bootstraps/${row.id}/health-check`, undefined, token)).status).toBe(403);
    expect((await api("GET", `/app-bootstraps/${row.id}`, undefined, token)).status).toBe(200);
  });

  it("dominio_gia_usato_da_un_app_risponde_409", async () => {
    await db.insert(appsTable).values({ name: "Altra", slug: "altra", baseUrl: "https://portfolio.fantamister.cloud" });
    const r = await api("POST", "/app-bootstraps", createBody());
    expect(r.status, r.text).toBe(409);
    expect(r.json.error).toBe("il dominio è già usato da un'altra App");
  });

  it("creazione_valida_risponde_201_con_il_numero_della_voce", async () => {
    const r = await api("POST", "/app-bootstraps", createBody());
    expect(r.status, r.text).toBe(201);
    const get = await api("GET", `/app-bootstraps/${r.json.id}`);
    expect(get.status).toBe(200);
    expect(get.json.pendingActionNumber).toBe(r.json.pendingActionNumber);
    expect(get.json.checklist).toHaveLength(7);
  });

  it("un_altro_utente_non_la_vede", async () => {
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
    const row = await insertRow(other!.id);
    expect((await api("GET", `/app-bootstraps/${row.id}`)).status).toBe(404);
    expect((await api("POST", `/app-bootstraps/${row.id}/health-check`)).status).toBe(404);
    expect((await api("PUT", `/app-bootstraps/${row.id}/checklist/neon`, { done: true })).status).toBe(404);
  });

  it("la_checklist_si_segna_a_mano_ma_non_le_voci_automatiche", async () => {
    const row = await insertRow(devId);
    const ok = await api("PUT", `/app-bootstraps/${row.id}/checklist/neon`, { done: true });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.checklist.find((i: { key: string }) => i.key === "neon").done).toBe(true);
    const off = await api("PUT", `/app-bootstraps/${row.id}/checklist/neon`, { done: false });
    expect(off.json.checklist.find((i: { key: string }) => i.key === "neon").done).toBe(false);
    const auto = await api("PUT", `/app-bootstraps/${row.id}/checklist/health`, { done: true });
    expect(auto.status).toBe(400);
    expect(auto.json.error).toBe("voce verificata da Botcave: non si segna a mano");
    expect((await api("PUT", `/app-bootstraps/${row.id}/checklist/boh`, { done: true })).status).toBe(404);
  });

  it("il_settimo_controllo_in_un_minuto_risponde_429", async () => {
    const row = await insertRow(devId);
    healthFetcher.current = async () => ({ ok: false, code: "unreachable" });
    for (let i = 0; i < 6; i++) expect((await api("POST", `/app-bootstraps/${row.id}/health-check`)).status).toBe(200);
    const r = await api("POST", `/app-bootstraps/${row.id}/health-check`);
    expect(r.status).toBe(429);
    expect(r.json.error).toBe("Troppe richieste: riprova tra poco");
  });

  it("apps_id_bootstrap_risponde_404_se_non_nata_da_zero", async () => {
    const [app] = await db.insert(appsTable).values({ name: "X", slug: "x", baseUrl: "http://localhost:1" }).returning();
    expect((await api("GET", `/apps/${app!.id}/bootstrap`)).status).toBe(404);
    await insertRow(devId, { appId: app!.id });
    expect((await api("GET", `/apps/${app!.id}/bootstrap`)).status).toBe(200);
  });
});

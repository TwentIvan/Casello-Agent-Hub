import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiAccountsTable, aiModelsTable, analysesTable, db, githubInstallationsTable, pool, usersTable } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "./fake-github";
import { clearInstallationTokenCache } from "../src/lib/github/app";
import { resetGithubConfigForTests } from "../src/lib/github/config";
import { encryptSecret } from "../src/lib/secrets";

// Prova di flusso della nuova app da zero: route vere con il login di sviluppo, finto GitHub (repository dal modello),
// analisi con la partenza in background simulata (la riga dell'analisi esiste), PGlite.
// richiesta → voce app_bootstrap → approvazione → passi → lista guidata → controllo di healthz con il fetcher iniettato;
// secondo scenario: errore del commit → passo personalize fallito → «Riprova» → done.

vi.mock("../src/lib/architect/run-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/architect/run-analysis")>();
  return { ...orig, startAnalysis: vi.fn(async () => {}) };
});

import { settleBootstrapRuns } from "../src/lib/app-bootstrap/service";
import type { WebFetcher } from "../src/lib/web-reader/fetch-page";

const REPO = "dev/portfolio";
const INST = 9;
const MARKER = JSON.stringify({ template: "botcave-modello-app", version: 1 });
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE", "APP_TEMPLATE_REPO"];
const saved: Record<string, string | undefined> = {};

let gh: FakeGithub;
let server: http.Server;
let base: string;
let devId: number;
let modelId: number;
let healthFetcher: { current: WebFetcher };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`attesa scaduta: ${what}`);
}

const requestBody = () => ({
  name: "Portfolio",
  slug: "portfolio",
  domain: "portfolio.fantamister.cloud",
  brief: "# Portfolio\n\nUn sito per i miei lavori.",
  repo: REPO,
  installationId: INST,
  aiModelId: modelId,
});

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  gh = await startFakeGithub();
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
    APP_TEMPLATE_REPO: "TwentIvan/botcave-modello-app",
  });
  resetGithubConfigForTests();
  const { default: app } = await import("../src/app");
  ({ healthFetcher } = await import("../src/routes/app-bootstraps"));
  server = http.createServer(app);
  base = await new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await gh.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetGithubConfigForTests();
  await pool.query("TRUNCATE users, apps, ai_accounts, github_installations, app_bootstraps, pending_actions, analyses RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearInstallationTokenCache();
  gh.installations.clear();
  gh.repos.clear();
  gh.templates.clear();
  gh.git.clear();
  gh.failWith = null;
  gh.addInstallation({ id: INST, appId: Number(gh.appId), accountLogin: "dev", accountType: "User", repositorySelection: "selected" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(INST, { contents: "write", metadata: "read" });
  gh.templates.set(REPO, "TwentIvan/botcave-modello-app");
  gh.seedRepo(REPO, "main", {
    ".botcave/modello.json": MARKER,
    "README.md": "# __APP_NAME__ su __DOMAIN__",
    "artifacts/__SLUG__-web/index.ts": "export const slug = '__SLUG__';",
    "AGENT_BRIEF.md": "brief di esempio",
  });

  await pool.query("TRUNCATE users, apps, ai_accounts, github_installations, app_bootstraps, pending_actions, analyses RESTART IDENTITY CASCADE");
  await api("GET", "/auth/me");
  const [dev] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  devId = dev!.id;
  await db.insert(githubInstallationsTable).values({ userId: devId, installationId: INST, accountLogin: "dev", accountType: "User", repositorySelection: "selected", userRepos: [REPO] });
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: devId, name: "Account", provider: "custom", baseUrl: "https://api.example.com/v1", apiKeyEnc: encryptSecret("sk-x"), status: "ok" })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  modelId = model!.id;
});

describe("nuova app da zero: flusso completo", () => {
  it("richiesta, approvazione, passi, lista guidata e controllo di healthz", async () => {
    const created = await api("POST", "/app-bootstraps", requestBody());
    expect(created.status).toBe(201);
    const { id, pendingActionNumber } = created.json;

    const item = await api("GET", `/pending-actions/${pendingActionNumber}`);
    expect(item.status).toBe(200);
    expect(item.json.kind).toBe("app_bootstrap");

    const approved = await api("POST", `/pending-actions/${pendingActionNumber}/approve`, {});
    expect(approved.status).toBe(200);

    await waitFor(async () => (await api("GET", `/app-bootstraps/${id}`)).json.status === "done", "richiesta done");
    await settleBootstrapRuns();
    const done = (await api("GET", `/app-bootstraps/${id}`)).json;
    expect(done.steps.map((s: { status: string }) => s.status)).toEqual(["done", "done", "done", "done"]);
    expect(done.appId).not.toBeNull();
    const [analysis] = await db.select().from(analysesTable).where(eq(analysesTable.id, done.analysisId));
    expect(analysis?.appId).toBe(done.appId);

    const forApp = await api("GET", `/apps/${done.appId}/bootstrap`);
    expect(forApp.status).toBe(200);
    expect(forApp.json.checklist).toHaveLength(7);
    expect(forApp.json.healthOkAt).toBeNull();

    const neon = await api("PUT", `/app-bootstraps/${id}/checklist/neon`, { done: true });
    expect(neon.status).toBe(200);
    expect(neon.json.checklist.find((i: { key: string }) => i.key === "neon").done).toBe(true);

    healthFetcher.current = async () => ({ ok: true, finalUrl: "", kind: "text", charset: null, body: Buffer.from("ok"), truncated: false, redirects: 0 }) as Awaited<ReturnType<WebFetcher>>;
    const health = await api("POST", `/app-bootstraps/${id}/health-check`);
    expect(health.status).toBe(200);
    expect(health.json.healthOkAt).not.toBeNull();
    expect(health.json.checklist.find((i: { key: string }) => i.key === "health").done).toBe(true);
  });

  it("errore del commit: passo personalize fallito, poi Riprova fino a done", async () => {
    const created = await api("POST", "/app-bootstraps", requestBody());
    const { id, pendingActionNumber } = created.json;
    gh.failWith = (req) => (req.method === "POST" && req.path.endsWith("/git/commits") ? 500 : null);
    expect((await api("POST", `/pending-actions/${pendingActionNumber}/approve`, {})).status).toBe(200);
    await settleBootstrapRuns();
    gh.failWith = null;
    const failed = (await api("GET", `/app-bootstraps/${id}`)).json;
    expect(failed.status).toBe("failed");
    expect(failed.steps.find((s: { key: string }) => s.key === "personalize").status).toBe("failed");

    const retry = await api("POST", `/app-bootstraps/${id}/retry`);
    expect(retry.status).toBe(202);
    await settleBootstrapRuns();
    const after = (await api("GET", `/app-bootstraps/${id}`)).json;
    expect(after.status).toBe("done");
    expect(after.steps.every((s: { status: string }) => s.status === "done")).toBe(true);
  });
});

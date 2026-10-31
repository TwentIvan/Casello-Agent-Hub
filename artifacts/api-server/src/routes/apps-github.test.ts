import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { db, pool, aiAccountsTable, aiModelsTable, analysesTable, appsTable, githubInstallationsTable } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../test/fake-github";
import { allowTestLoopback } from "../../test/fake-provider";
import { encryptSecret } from "../lib/secrets";

// Sorgenti GitHub tramite l'App: salvataggio dell'app con `sourceInstallationId` e avvio
// dell'analisi senza token manuale. File separato da analyses.test.ts perché il rate limit degli
// avvii (10 al minuto per IP) è per processo. Senza login (AUTH_DISABLED=true: utente di sviluppo);
// il finto provider (modello dell'utente di sviluppo) rifiuta ogni chiamata, così le analisi avviate finiscono subito.

const GITHUB_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_API_BASE",
  "GITHUB_WEB_BASE",
];
const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY", ...GITHUB_KEYS];
const saved: Record<string, string | undefined> = {};

const NOT_YOURS = "installazione non trovata o non tua";
const NOT_CONFIGURED = "GitHub non configurato";
const UNAVAILABLE = "GitHub non risponde (riprova più tardi)";

let gh: FakeGithub;
let server: http.Server;
let llm: http.Server;
let fakeApp: http.Server;
let base: string;
let fakeAppBase: string;
let userId: number;
let otherUserId: number;
let resetConfig: () => void;
let clearTokenCache: () => void;
// Modello di un account dell'utente di sviluppo verso il finto provider `llm`
let modelId: number;
let restoreLoopback: () => void;

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

function close(s: http.Server): Promise<void> {
  return new Promise((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  });
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as any) : undefined };
}

function configureGithub() {
  Object.assign(process.env, {
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
  });
  resetConfig();
}

function fakeInstallation(id: number, login: string, repos: string[]) {
  gh.addInstallation(
    { id, appId: Number(gh.appId), accountLogin: login, accountType: "User", repositorySelection: "selected" },
    repos.map((fullName) => ({ fullName, defaultBranch: "main", private: true })),
  );
}

async function addRow(installationId: number, forUser = userId) {
  await db.insert(githubInstallationsTable).values({
    userId: forUser,
    installationId,
    accountLogin: `acc${installationId}`,
    accountType: "User",
    repositorySelection: "selected",
  });
}

const appBody = (extra: Record<string, unknown> = {}) => ({ name: "Mister", baseUrl: fakeAppBase, ...extra });

/** Attende che nessuna analisi resti queued/running (il finto provider le fa fallire subito). */
async function settleAnalyses() {
  for (let i = 0; i < 500; i++) {
    const active = await db
      .select({ id: analysesTable.id })
      .from(analysesTable)
      .where(inArray(analysesTable.status, ["queued", "running"]));
    if (!active.length) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("analisi ancora attive dopo il test");
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "d".repeat(64);
  gh = await startFakeGithub();

  llm = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "rifiutato dal test" } }));
    });
  });
  fakeApp = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.statusCode = 404;
      res.end();
    });
  });
  const llmBase = `http://127.0.0.1:${await listen(llm)}/v1`;
  fakeAppBase = `http://127.0.0.1:${await listen(fakeApp)}`;

  const { default: app } = await import("../app");
  ({ resetGithubConfigForTests: resetConfig } = await import("../lib/github/config"));
  ({ clearInstallationTokenCache: clearTokenCache } = await import("../lib/github/app"));
  const { ensureUserByEmail } = await import("../lib/users");
  userId = (await ensureUserByEmail("dev@localhost")).id;
  otherUserId = (await ensureUserByEmail("altro@example.com")).id;
  restoreLoopback = allowTestLoopback();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId,
      name: "Account di prova",
      provider: "custom",
      baseUrl: llmBase,
      allowPrivateNetwork: true,
      apiKeyEnc: encryptSecret("sk-test"),
      status: "ok",
    })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "modello", displayName: "M" }).returning();
  modelId = model!.id;

  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  await settleAnalyses();
  await close(server);
  await close(llm);
  await close(fakeApp);
  await gh.close();
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  restoreLoopback();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetConfig();
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE github_installations RESTART IDENTITY");
  gh.installations.clear();
  gh.repos.clear();
  gh.revoked.clear();
  gh.zipballs.clear();
  gh.requests.length = 0;
  gh.failWith = null;
  gh.failHeaders = {};
  clearTokenCache();
  configureGithub();
  fakeInstallation(11, "ivan", ["ivan/mister"]);
  fakeInstallation(22, "acme", ["acme/app"]);
  gh.zipballs.set("ivan/mister", zipSync({ "mister-abc/src/a.ts": strToU8("export const a = 1;\n") }));
});

afterEach(async () => {
  await settleAnalyses();
});

describe("salvataggio dell'app con l'installazione", () => {
  it("installazione dell'utente e repo giusto: 201/200 e sourceInstallationId nella risposta", async () => {
    await addRow(11);
    const created = await api("POST", "/apps", appBody({ sourceType: "github", sourceRepo: "ivan/mister", sourceInstallationId: 11 }));
    expect(created.status, created.text).toBe(201);
    expect(created.json).toMatchObject({ sourceType: "github", sourceRepo: "ivan/mister", sourceInstallationId: 11, sourceTokenSet: false });
    expect((await api("GET", `/apps/${created.json.id}`)).json.sourceInstallationId).toBe(11);
    expect(gh.requests.map((r) => r.path)).toEqual(["/repos/ivan/mister/installation"]);

    // PATCH che imposta l'installazione su un'app esistente
    const plain = await api("POST", "/apps", appBody({ name: "Altra", sourceType: "github", sourceRepo: "ivan/mister" }));
    expect(plain.json.sourceInstallationId).toBeNull();
    const patched = await api("PATCH", `/apps/${plain.json.id}`, { sourceInstallationId: 11 });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.json.sourceInstallationId).toBe(11);

    // null torna al token manuale
    const back = await api("PATCH", `/apps/${plain.json.id}`, { sourceInstallationId: null });
    expect(back.status).toBe(200);
    expect(back.json.sourceInstallationId).toBeNull();
  });

  it("installazione non dell'utente → 400, nessuna app creata", async () => {
    await addRow(11, otherUserId);
    const res = await api("POST", "/apps", appBody({ sourceType: "github", sourceRepo: "ivan/mister", sourceInstallationId: 11 }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: NOT_YOURS });
    expect((await api("GET", "/apps")).json).toEqual([]);
  });

  it("repo di un'altra installazione → 400", async () => {
    await addRow(11);
    await addRow(22);
    const res = await api("POST", "/apps", appBody({ sourceType: "github", sourceRepo: "acme/app", sourceInstallationId: 11 }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: NOT_YOURS });
    // Repo che nessuna installazione vede (404 da GitHub): stesso errore
    const unknown = await api("POST", "/apps", appBody({ sourceType: "github", sourceRepo: "ivan/sconosciuto", sourceInstallationId: 11 }));
    expect(unknown.status).toBe(400);
    expect(unknown.json).toEqual({ error: NOT_YOURS });
  });

  it("sorgente diversa da github o repo mancante con l'installazione → 400", async () => {
    await addRow(11);
    for (const extra of [
      { sourceType: "none", sourceInstallationId: 11 },
      { sourceType: "zip", sourceRepo: "ivan/mister", sourceInstallationId: 11 },
      { sourceInstallationId: 11 },
      { sourceType: "github", sourceRepo: "ivan/mister", sourceInstallationId: 0 },
    ]) {
      const res = await api("POST", "/apps", appBody(extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const noRepo = await api("POST", "/apps", appBody({ sourceType: "none", sourceInstallationId: 11 }));
    expect(noRepo.json).toEqual({ error: NOT_YOURS });
    expect((await api("GET", "/apps")).json).toEqual([]);
  });

  it("GitHub non configurato → 400 'GitHub non configurato'; senza installazione nessun controllo", async () => {
    await addRow(11);
    for (const k of GITHUB_KEYS) delete process.env[k];
    resetConfig();
    const res = await api("POST", "/apps", appBody({ sourceType: "github", sourceRepo: "ivan/mister", sourceInstallationId: 11 }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: NOT_CONFIGURED });
    const manual = await api("POST", "/apps", appBody({ sourceType: "github", sourceRepo: "ivan/mister", sourceToken: "ghp_x" }));
    expect(manual.status).toBe(201);
    expect(manual.json.sourceInstallationId).toBeNull();
  });

  it("GitHub non risponde → 502", async () => {
    await addRow(11);
    gh.failWith = () => 500;
    const res = await api("POST", "/apps", appBody({ sourceType: "github", sourceRepo: "ivan/mister", sourceInstallationId: 11 }));
    expect(res.status).toBe(502);
    expect(res.json).toEqual({ error: UNAVAILABLE });
  });

  it("PATCH non legate alla sorgente non chiamano GitHub; cambiare repo ricontrolla", async () => {
    await addRow(11);
    await addRow(22);
    const created = await api("POST", "/apps", appBody({ sourceType: "github", sourceRepo: "ivan/mister", sourceInstallationId: 11 }));
    gh.requests.length = 0;
    const renamed = await api("PATCH", `/apps/${created.json.id}`, { name: "Nuovo nome", sourceBranch: "dev", sourceInstallationId: 11 });
    expect(renamed.status, renamed.text).toBe(200);
    expect(renamed.json.sourceInstallationId).toBe(11);
    expect(gh.requests).toHaveLength(0);

    // Repo cambiato: lo stato risultante (installazione 11 salvata) non torna
    const wrong = await api("PATCH", `/apps/${created.json.id}`, { sourceRepo: "acme/app" });
    expect(wrong.status).toBe(400);
    expect(wrong.json).toEqual({ error: NOT_YOURS });
    const ok = await api("PATCH", `/apps/${created.json.id}`, { sourceRepo: "acme/app", sourceInstallationId: 22 });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({ sourceRepo: "acme/app", sourceInstallationId: 22 });
  });

  it("passare a una sorgente diversa da github azzera sourceInstallationId", async () => {
    await addRow(11);
    const created = await api("POST", "/apps", appBody({ sourceType: "github", sourceRepo: "ivan/mister", sourceInstallationId: 11 }));
    gh.requests.length = 0;
    const res = await api("PATCH", `/apps/${created.json.id}`, { sourceType: "none" });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ sourceType: "none", sourceInstallationId: null });
    expect(gh.requests).toHaveLength(0);
  });
});

describe("avvio dell'analisi con l'installazione", () => {
  it("senza token manuale → 202; il download usa il token di installazione", async () => {
    await addRow(11);
    const created = await api("POST", "/apps", appBody({ sourceType: "github", sourceRepo: "ivan/mister", sourceInstallationId: 11 }));
    expect(created.json.sourceTokenSet).toBe(false);
    const res = await api("POST", `/apps/${created.json.id}/analyses`, { aiModelId: modelId });
    expect(res.status, res.text).toBe(202);
    expect(res.json).toMatchObject({ status: "queued", sources: { code: "github" } });
    await settleAnalyses();
    const zipball = gh.requests.find((r) => r.path.startsWith("/repos/ivan/mister/zipball"));
    expect(zipball?.auth).toMatch(/^Bearer ghs_/);
    const [row] = await db.select().from(analysesTable).where(eq(analysesTable.id, res.json.id));
    expect(JSON.stringify(row)).not.toContain("ghs_");
  });

  it("installazione di un altro utente → 403 e nessuna analisi", async () => {
    await addRow(11, otherUserId);
    const [app] = await db
      .insert(appsTable)
      .values({ name: "Mister", slug: "mister", baseUrl: fakeAppBase, sourceType: "github", sourceRepo: "ivan/mister", sourceInstallationId: 11 })
      .returning();
    const res = await api("POST", `/apps/${app!.id}/analyses`, { aiModelId: modelId });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: NOT_YOURS });
    expect(await db.select().from(analysesTable)).toHaveLength(0);
  });
});

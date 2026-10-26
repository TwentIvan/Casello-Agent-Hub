import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, githubInstallationsTable, pool } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../test/fake-github";

// GET /github/installations e /github/repos contro il finto GitHub, senza login (AUTH_DISABLED=true:
// utente di sviluppo). Le righe delle installazioni si inseriscono a mano. La configurazione GitHub
// si legge dalle variabili d'ambiente: cambiandole e chiamando resetGithubConfigForTests() la
// stessa app passa da "configurato" a "non configurato".

const GITHUB_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_API_BASE",
  "GITHUB_WEB_BASE",
];
const ENV_KEYS = ["AUTH_DISABLED", ...GITHUB_KEYS];
const saved: Record<string, string | undefined> = {};

const UNAVAILABLE = "GitHub non risponde (riprova più tardi)";
const NOT_CONFIGURED = "GitHub non configurato";

let gh: FakeGithub;
let server: http.Server;
let base: string;
let userId: number;
let resetConfig: () => void;
let clearTokenCache: () => void;

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

async function get(path: string) {
  const res = await fetch(`${base}/api${path}`);
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as any) : undefined };
}

async function addRow(installationId: number, accountLogin: string, accountType: "User" | "Organization", repositorySelection = "all") {
  await db.insert(githubInstallationsTable).values({ userId, installationId, accountLogin, accountType, repositorySelection });
}

function fakeInstallation(id: number, login: string, type: "User" | "Organization", repos: { fullName: string; defaultBranch?: string; private?: boolean }[]) {
  gh.addInstallation(
    { id, appId: Number(gh.appId), accountLogin: login, accountType: type, repositorySelection: "all" },
    repos.map((r) => ({ fullName: r.fullName, defaultBranch: r.defaultBranch ?? "main", private: r.private ?? false })),
  );
}

async function rowIds(): Promise<number[]> {
  const rows = await db.select().from(githubInstallationsTable).where(eq(githubInstallationsTable.userId, userId));
  return rows.map((r) => r.installationId).sort((a, b) => a - b);
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  gh = await startFakeGithub();

  const { default: app } = await import("../app");
  const { resetGithubConfigForTests } = await import("../lib/github/config");
  resetConfig = resetGithubConfigForTests;
  ({ clearInstallationTokenCache: clearTokenCache } = await import("../lib/github/app"));
  const { ensureUserByEmail } = await import("../lib/users");
  userId = (await ensureUserByEmail("dev@localhost")).id;

  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await gh.close();
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetConfig();
});

beforeEach(async () => {
  await pool.query("TRUNCATE github_installations RESTART IDENTITY");
  gh.installations.clear();
  gh.repos.clear();
  gh.revoked.clear();
  gh.requests.length = 0;
  gh.failWith = null;
  gh.failHeaders = {};
  clearTokenCache();
  configureGithub();
});

describe("GET /github/installations", () => {
  it("elenca le installazioni con manageUrl per utente e organizzazione, più installUrl", async () => {
    await addRow(11, "ivan", "User", "selected");
    await addRow(22, "acme", "Organization");
    const res = await get("/github/installations");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({
      installUrl: `${gh.webBase}/apps/${gh.slug}/installations/new`,
      installations: [
        { installationId: 11, accountLogin: "ivan", accountType: "User", repositorySelection: "selected", manageUrl: `${gh.webBase}/settings/installations/11` },
        {
          installationId: 22,
          accountLogin: "acme",
          accountType: "Organization",
          repositorySelection: "all",
          manageUrl: `${gh.webBase}/organizations/acme/settings/installations/22`,
        },
      ],
    });
    // Solo righe del DB: nessuna chiamata a GitHub
    expect(gh.requests).toHaveLength(0);
  });

  it("senza installazioni: elenco vuoto e installUrl", async () => {
    const res = await get("/github/installations");
    expect(res.status).toBe(200);
    expect(res.json.installations).toEqual([]);
    expect(res.json.installUrl).toBe(`${gh.webBase}/apps/${gh.slug}/installations/new`);
  });

  it("il login dell'organizzazione è codificato nell'URL", async () => {
    await addRow(33, "a/b?c", "Organization");
    const res = await get("/github/installations");
    expect(res.json.installations[0].manageUrl).toBe(`${gh.webBase}/organizations/a%2Fb%3Fc/settings/installations/33`);
  });

  it("GitHub non configurato: 404", async () => {
    for (const k of GITHUB_KEYS) delete process.env[k];
    resetConfig();
    const res = await get("/github/installations");
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: NOT_CONFIGURED });
  });
});

describe("GET /github/repos", () => {
  it("unisce i repo di due installazioni, ordinati per fullName", async () => {
    fakeInstallation(11, "ivan", "User", [{ fullName: "ivan/remove", defaultBranch: "dev", private: true }, { fullName: "ivan/mister" }]);
    fakeInstallation(22, "acme", "Organization", [{ fullName: "acme/zeta" }, { fullName: "acme/Beta" }]);
    await addRow(11, "ivan", "User");
    await addRow(22, "acme", "Organization");
    const res = await get("/github/repos");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual([
      { installationId: 22, fullName: "acme/Beta", defaultBranch: "main", private: false },
      { installationId: 22, fullName: "acme/zeta", defaultBranch: "main", private: false },
      { installationId: 11, fullName: "ivan/mister", defaultBranch: "main", private: false },
      { installationId: 11, fullName: "ivan/remove", defaultBranch: "dev", private: true },
    ]);
  });

  it("ordine indipendente dalla lingua: confronto per codice (maiuscole prima)", async () => {
    fakeInstallation(11, "ivan", "User", [{ fullName: "ivan/b" }, { fullName: "ivan/B" }, { fullName: "Ivan/z" }]);
    await addRow(11, "ivan", "User");
    const res = await get("/github/repos");
    expect(res.json.map((r: { fullName: string }) => r.fullName)).toEqual(["Ivan/z", "ivan/B", "ivan/b"]);
  });

  it("un repo visto da due installazioni compare una volta, con la prima installazione", async () => {
    fakeInstallation(11, "ivan", "User", [{ fullName: "acme/shared" }]);
    fakeInstallation(22, "acme", "Organization", [{ fullName: "acme/shared" }, { fullName: "acme/solo" }]);
    await addRow(11, "ivan", "User");
    await addRow(22, "acme", "Organization");
    const res = await get("/github/repos");
    expect(res.json).toEqual([
      { installationId: 11, fullName: "acme/shared", defaultBranch: "main", private: false },
      { installationId: 22, fullName: "acme/solo", defaultBranch: "main", private: false },
    ]);
  });

  it("un'installazione revocata sparisce dalla tabella e gli altri repo arrivano", async () => {
    fakeInstallation(11, "ivan", "User", [{ fullName: "ivan/mister" }]);
    fakeInstallation(22, "acme", "Organization", [{ fullName: "acme/app" }]);
    await addRow(11, "ivan", "User");
    await addRow(22, "acme", "Organization");
    gh.revoked.add(11);
    const res = await get("/github/repos");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual([{ installationId: 22, fullName: "acme/app", defaultBranch: "main", private: false }]);
    expect(await rowIds()).toEqual([22]);
  });

  it("installazione sconosciuta a GitHub (404): eliminata", async () => {
    fakeInstallation(22, "acme", "Organization", [{ fullName: "acme/app" }]);
    await addRow(99, "fantasma", "User");
    await addRow(22, "acme", "Organization");
    const res = await get("/github/repos");
    expect(res.status).toBe(200);
    expect(await rowIds()).toEqual([22]);
  });

  it("senza installazioni: elenco vuoto", async () => {
    const res = await get("/github/repos");
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
  });

  it.each([403, 422])("installazione sospesa (%s sul token): saltata, la riga resta, gli altri repo arrivano", async (status) => {
    fakeInstallation(11, "ivan", "User", [{ fullName: "ivan/mister" }]);
    fakeInstallation(22, "acme", "Organization", [{ fullName: "acme/app" }]);
    await addRow(11, "ivan", "User");
    await addRow(22, "acme", "Organization");
    gh.failWith = (r) => (r.path === "/app/installations/11/access_tokens" ? status : null);
    const res = await get("/github/repos");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual([{ installationId: 22, fullName: "acme/app", defaultBranch: "main", private: false }]);
    expect(await rowIds()).toEqual([11, 22]);
  });

  it("403 sull'elenco dei repo (non revoca): installazione saltata, la riga resta", async () => {
    fakeInstallation(11, "ivan", "User", [{ fullName: "ivan/mister" }]);
    await addRow(11, "ivan", "User");
    gh.failWith = (r) => (r.path.startsWith("/installation/repositories") ? 403 : null);
    const res = await get("/github/repos");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual([]);
    expect(await rowIds()).toEqual([11]);
  });

  it.each([
    ["500", () => 500, {}],
    ["403 con rate limit", () => 403, { "x-ratelimit-remaining": "0" }],
    ["403 con retry-after", () => 403, { "retry-after": "60" }],
  ])("errore %s da GitHub: 502 e l'installazione resta", async (_n, status, headers) => {
    fakeInstallation(11, "ivan", "User", [{ fullName: "ivan/mister" }]);
    fakeInstallation(22, "acme", "Organization", [{ fullName: "acme/app" }]);
    await addRow(11, "ivan", "User");
    await addRow(22, "acme", "Organization");
    gh.failHeaders = headers;
    gh.failWith = (r) => (r.path.startsWith("/installation/repositories") ? status() : null);
    const res = await get("/github/repos");
    expect(res.status).toBe(502);
    expect(res.json).toEqual({ error: UNAVAILABLE });
    expect(await rowIds()).toEqual([11, 22]);
  });

  it("chiave dell'App sbagliata (JWT rifiutato, 401): 502 e nessuna installazione eliminata", async () => {
    fakeInstallation(11, "ivan", "User", [{ fullName: "ivan/mister" }]);
    await addRow(11, "ivan", "User");
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env["GITHUB_APP_PRIVATE_KEY"] = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    resetConfig();
    const res = await get("/github/repos");
    expect(res.status).toBe(502);
    expect(res.json).toEqual({ error: UNAVAILABLE });
    expect(await rowIds()).toEqual([11]);
  });

  it("le installazioni di un altro utente non si elencano né si eliminano", async () => {
    const { ensureUserByEmail } = await import("../lib/users");
    const otherId = (await ensureUserByEmail("altro@example.com")).id;
    fakeInstallation(11, "ivan", "User", [{ fullName: "ivan/mister" }]);
    fakeInstallation(22, "acme", "Organization", [{ fullName: "acme/app" }]);
    await addRow(11, "ivan", "User");
    await db.insert(githubInstallationsTable).values([
      { userId: otherId, installationId: 22, accountLogin: "acme", accountType: "Organization", repositorySelection: "all" },
      // Revocata, ma dell'altro utente: resta com'è
      { userId: otherId, installationId: 33, accountLogin: "fantasma", accountType: "User", repositorySelection: "all" },
    ]);
    const inst = await get("/github/installations");
    expect(inst.json.installations.map((i: { installationId: number }) => i.installationId)).toEqual([11]);
    const repos = await get("/github/repos");
    expect(repos.status).toBe(200);
    expect(repos.json).toEqual([{ installationId: 11, fullName: "ivan/mister", defaultBranch: "main", private: false }]);
    // Nessuna chiamata a GitHub per le installazioni dell'altro utente
    expect(gh.requests.some((r) => r.path.includes("/installations/22/") || r.path.includes("/installations/33/"))).toBe(false);
    const others = await db.select().from(githubInstallationsTable).where(eq(githubInstallationsTable.userId, otherId));
    expect(others.map((r) => r.installationId).sort((a, b) => a - b)).toEqual([22, 33]);
  });

  it("GitHub irraggiungibile: 502", async () => {
    await addRow(11, "ivan", "User");
    process.env["GITHUB_API_BASE"] = "http://127.0.0.1:1";
    resetConfig();
    const res = await get("/github/repos");
    expect(res.status).toBe(502);
    expect(res.json).toEqual({ error: UNAVAILABLE });
    expect(await rowIds()).toEqual([11]);
  });

  it("GitHub non configurato: 404", async () => {
    for (const k of GITHUB_KEYS) delete process.env[k];
    resetConfig();
    const res = await get("/github/repos");
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: NOT_CONFIGURED });
  });

  it("nessuna risposta contiene token o segreti", async () => {
    fakeInstallation(11, "ivan", "User", [{ fullName: "ivan/mister" }]);
    await addRow(11, "ivan", "User");
    const texts = [(await get("/github/installations")).text, (await get("/github/repos")).text];
    gh.failWith = () => 500;
    texts.push((await get("/github/repos")).text);
    for (const t of texts) {
      expect(t).not.toContain("ghs_");
      expect(t).not.toContain("ghu_");
      expect(t).not.toContain("PRIVATE KEY");
      expect(t).not.toContain(gh.clientSecret);
    }
  });
});

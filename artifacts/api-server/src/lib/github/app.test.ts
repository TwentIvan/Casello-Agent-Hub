import http from "node:http";
import type { AddressInfo } from "node:net";
import { createPrivateKey, generateKeyPairSync, verify } from "node:crypto";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { loadGithubConfig, type GithubConfig } from "./config";
import {
  appJwt,
  clearInstallationTokenCache,
  exchangeCode,
  getGithubUser,
  getVerifiedEmails,
  GithubError,
  installationToken,
  listInstallationRepos,
  listUserInstallations,
  repoInstallationId,
} from "./app";

const NO_ACCESS = "l'App Casello non ha più accesso a questo repository: reinstallala o scegli un altro repo";
const UNAVAILABLE = "GitHub non risponde (riprova più tardi)";
const USER_TOKEN = "ghu_USER_TOKEN_SEGRETO";

let gh: FakeGithub;
let cfg: GithubConfig;
/** Tutti i messaggi d'errore visti: alla fine nessuno deve contenere token, chiave o URL. */
const messages: string[] = [];

async function expectGithubError(p: Promise<unknown>, message: string, status?: number | null): Promise<GithubError> {
  const err = await p.then(
    () => {
      throw new Error("doveva fallire");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GithubError);
  const ge = err as GithubError;
  messages.push(ge.message);
  expect(ge.message).toBe(message);
  if (status !== undefined) expect(ge.status).toBe(status);
  return ge;
}

function envFor(fake: FakeGithub): Record<string, string> {
  return {
    GITHUB_APP_ID: fake.appId,
    GITHUB_APP_SLUG: fake.slug,
    GITHUB_APP_CLIENT_ID: fake.clientId,
    GITHUB_APP_CLIENT_SECRET: fake.clientSecret,
    GITHUB_APP_PRIVATE_KEY: fake.privateKeyPem,
    GITHUB_API_BASE: fake.apiBase,
    GITHUB_WEB_BASE: fake.webBase,
  };
}

beforeAll(async () => {
  gh = await startFakeGithub();
  cfg = loadGithubConfig(envFor(gh))!;
});

afterAll(async () => {
  await gh.close();
  for (const m of messages) {
    expect(m).not.toContain(USER_TOKEN);
    expect(m).not.toContain("ghs_");
    expect(m).not.toContain("PRIVATE KEY");
    expect(m).not.toContain(gh.clientSecret);
    expect(m).not.toMatch(/https?:\/\//);
    expect(m).not.toContain("127.0.0.1");
  }
});

beforeEach(() => {
  clearInstallationTokenCache();
  gh.requests.length = 0;
  gh.failWith = null;
  gh.revoked.clear();
  gh.tokenTtlMs = 3_600_000;
  gh.installations.clear();
  gh.repos.clear();
  gh.users.clear();
  gh.codes.clear();
});

describe("loadGithubConfig", () => {
  it("null se manca (o è vuota) una variabile", () => {
    const env = envFor(gh);
    for (const k of ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"]) {
      const partial: Record<string, string> = { ...env };
      delete partial[k];
      expect(loadGithubConfig(partial)).toBeNull();
      expect(loadGithubConfig({ ...env, [k]: "  " })).toBeNull();
    }
  });

  it("`\\n` letterali diventano a capo: la PEM è valida", () => {
    const flat = gh.privateKeyPem.trim().replace(/\n/g, "\\n");
    expect(flat).not.toContain("\n");
    const c = loadGithubConfig({ ...envFor(gh), GITHUB_APP_PRIVATE_KEY: flat })!;
    expect(c.privateKey).toContain("\n");
    expect(() => createPrivateKey(c.privateKey)).not.toThrow();
  });

  it("basi di default e override solo fuori produzione", () => {
    const { GITHUB_API_BASE: _a, GITHUB_WEB_BASE: _w, ...base } = envFor(gh);
    expect(loadGithubConfig(base)).toMatchObject({ apiBase: "https://api.github.com", webBase: "https://github.com" });
    expect(loadGithubConfig({ ...envFor(gh), NODE_ENV: "test" })).toMatchObject({ apiBase: gh.apiBase, webBase: gh.webBase });
    expect(loadGithubConfig({ ...envFor(gh), NODE_ENV: "production" })).toMatchObject({
      apiBase: "https://api.github.com",
      webBase: "https://github.com",
    });
  });
});

describe("appJwt", () => {
  it("RS256 verificabile con la chiave pubblica, iat = ora − 60, exp − iat = 600, iss = appId", () => {
    const now = 1_800_000_000_000;
    const jwt = appJwt(cfg, () => now);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as { iat: number; exp: number; iss: string };
    expect(payload.iat).toBe(now / 1000 - 60);
    expect(payload.exp - payload.iat).toBe(600);
    expect(payload.iss).toBe(gh.appId);
    expect(verify("sha256", Buffer.from(`${h}.${p}`), gh.publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("accetta anche una chiave PKCS#8", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(appJwt({ ...cfg, privateKey: pem }).split(".")).toHaveLength(3);
  });

  it("chiave non valida: 'GitHub non configurato', senza ripetere la chiave", () => {
    const bad = "-----BEGIN RSA PRIVATE KEY-----\nNONVALIDA\n-----END RSA PRIVATE KEY-----";
    let err: unknown;
    try {
      appJwt({ ...cfg, privateKey: bad });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GithubError);
    expect((err as GithubError).message).toBe("GitHub non configurato");
    messages.push((err as GithubError).message);
  });
});

describe("installationToken", () => {
  beforeEach(() => {
    gh.addInstallation({ id: 7, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
      { fullName: "ivan/mister", defaultBranch: "main", private: true },
      { fullName: "ivan/remove", defaultBranch: "dev", private: false },
    ]);
  });

  it("con scope: solo il nome del repo e contents: read; la seconda chiamata usa la cache", async () => {
    const t1 = await installationToken(cfg, 7, { repo: "ivan/mister" });
    const t2 = await installationToken(cfg, 7, { repo: "ivan/mister" });
    expect(t1).toBe(t2);
    const calls = gh.requests.filter((r) => r.path === "/app/installations/7/access_tokens");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ repositories: ["mister"], permissions: { contents: "read" } });
    expect(calls[0]!.auth).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
    expect(gh.issuedTokens.get(t1)).toMatchObject({ installationId: 7, repositories: ["ivan/mister"] });

    // Chiavi di cache distinte per repo e senza scope
    const all = await installationToken(cfg, 7);
    expect(all).not.toBe(t1);
    expect(gh.issuedTokens.get(all)!.repositories).toBeNull();
    expect(gh.requests.filter((r) => r.path === "/app/installations/7/access_tokens")).toHaveLength(2);
    expect(gh.requests[1]!.body).toBeNull();
  });

  it("token vicino alla scadenza (meno di 5 minuti): se ne chiede uno nuovo", async () => {
    gh.tokenTtlMs = 4 * 60_000;
    const t1 = await installationToken(cfg, 7);
    const t2 = await installationToken(cfg, 7);
    expect(t2).not.toBe(t1);
    expect(gh.requests).toHaveLength(2);
  });

  it("installazione revocata: messaggio della spec, stato 404", async () => {
    gh.revoked.add(7);
    await expectGithubError(installationToken(cfg, 7), NO_ACCESS, 404);
  });

  it("installazione sconosciuta: stesso messaggio", async () => {
    await expectGithubError(installationToken(cfg, 999, { repo: "ivan/mister" }), NO_ACCESS);
  });

  it("chiave dell'App sbagliata (JWT rifiutato, 401): stesso messaggio", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const other = { ...cfg, privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
    await expectGithubError(installationToken(other, 7), NO_ACCESS, 401);
  });

  it("errore 5xx: GitHub non risponde", async () => {
    gh.failWith = () => 502;
    await expectGithubError(installationToken(cfg, 7), UNAVAILABLE, 502);
  });
});

describe("listInstallationRepos", () => {
  it("pagina oltre 100", async () => {
    const repos = Array.from({ length: 250 }, (_, i) => ({ fullName: `org/repo-${String(i).padStart(3, "0")}`, defaultBranch: "main", private: i % 2 === 0 }));
    gh.addInstallation({ id: 9, appId: Number(gh.appId), accountLogin: "org", accountType: "Organization", repositorySelection: "all" }, repos);
    const list = await listInstallationRepos(cfg, 9);
    expect(list).toHaveLength(250);
    expect(list[0]).toEqual({ fullName: "org/repo-000", defaultBranch: "main", private: true });
    expect(list[249]).toEqual({ fullName: "org/repo-249", defaultBranch: "main", private: false });
    const pages = gh.requests.filter((r) => r.path.startsWith("/installation/repositories")).map((r) => r.path);
    expect(pages).toEqual([
      "/installation/repositories?per_page=100&page=1",
      "/installation/repositories?per_page=100&page=2",
      "/installation/repositories?per_page=100&page=3",
    ]);
  });

  it("al massimo 1000 repo", async () => {
    const repos = Array.from({ length: 1050 }, (_, i) => ({ fullName: `org/r${i}`, defaultBranch: "main", private: false }));
    gh.addInstallation({ id: 10, appId: Number(gh.appId), accountLogin: "org", accountType: "Organization", repositorySelection: "all" }, repos);
    expect(await listInstallationRepos(cfg, 10)).toHaveLength(1000);
  });

  it("installazione revocata dopo il token in cache: messaggio della spec e cache svuotata", async () => {
    gh.addInstallation({ id: 11, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" }, []);
    await listInstallationRepos(cfg, 11);
    gh.revoked.add(11);
    await expectGithubError(listInstallationRepos(cfg, 11), NO_ACCESS, 401);
    gh.revoked.delete(11);
    gh.requests.length = 0;
    await listInstallationRepos(cfg, 11);
    // Il token scartato non viene riusato: se ne chiede uno nuovo
    expect(gh.requests.filter((r) => r.path === "/app/installations/11/access_tokens")).toHaveLength(1);
  });
});

describe("repoInstallationId", () => {
  it("id dell'installazione che vede il repo, null se nessuna (404)", async () => {
    gh.addInstallation({ id: 12, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
      { fullName: "ivan/mister", defaultBranch: "main", private: true },
    ]);
    expect(await repoInstallationId(cfg, "ivan/mister")).toBe(12);
    expect(await repoInstallationId(cfg, "ivan/altro")).toBeNull();
    expect(gh.requests.map((r) => r.path)).toEqual(["/repos/ivan/mister/installation", "/repos/ivan/altro/installation"]);
  });
});

describe("OAuth e dati dell'utente", () => {
  beforeEach(() => {
    gh.addUser(USER_TOKEN, { id: 5150, login: "ivanlt", name: "Ivan", avatarUrl: "https://avatars.example/5150" }, {
      emails: [
        { email: "Ivan@Example.com", verified: true, primary: true },
        { email: "ivan@work.example", verified: true, primary: false },
        { email: "falso@example.com", verified: false, primary: false },
      ],
      installations: [7, 8],
    });
  });

  it("exchangeCode: JSON con client_id, client_secret, code e code_verifier", async () => {
    gh.addCode("codice-1", USER_TOKEN, "verifier-abc");
    expect(await exchangeCode(cfg, "codice-1", "verifier-abc")).toBe(USER_TOKEN);
    const req = gh.requests.find((r) => r.host === "web")!;
    expect(req).toMatchObject({ method: "POST", path: "/login/oauth/access_token" });
    expect(req.body).toEqual({ client_id: gh.clientId, client_secret: "***", code: "codice-1", code_verifier: "***" });
  });

  it("exchangeCode senza PKCE: niente code_verifier", async () => {
    gh.addCode("codice-2", USER_TOKEN);
    expect(await exchangeCode(cfg, "codice-2", null)).toBe(USER_TOKEN);
    expect(gh.requests[0]!.body).toEqual({ client_id: gh.clientId, client_secret: "***", code: "codice-2" });
  });

  it("exchangeCode con codice non valido o verifier sbagliato: 'accesso con GitHub non riuscito', 400", async () => {
    await expectGithubError(exchangeCode(cfg, "codice-inesistente", null), "accesso con GitHub non riuscito", 400);
    gh.addCode("codice-3", USER_TOKEN, "giusto");
    await expectGithubError(exchangeCode(cfg, "codice-3", "sbagliato"), "accesso con GitHub non riuscito", 400);
  });

  it("getGithubUser: id come stringa", async () => {
    expect(await getGithubUser(cfg, USER_TOKEN)).toEqual({ id: "5150", login: "ivanlt", name: "Ivan", avatarUrl: "https://avatars.example/5150" });
    expect(gh.requests[0]!.auth).toBe(`Bearer ${USER_TOKEN}`);
  });

  it("getGithubUser con token non valido: errore con testo fisso", async () => {
    await expectGithubError(getGithubUser(cfg, "ghu_ALTRO"), "accesso con GitHub non riuscito", 401);
  });

  it("getVerifiedEmails: scarta le non verificate, minuscole", async () => {
    expect(await getVerifiedEmails(cfg, USER_TOKEN)).toEqual({
      primary: "ivan@example.com",
      all: ["ivan@example.com", "ivan@work.example"],
    });
  });

  it("listUserInstallations: filtra un app_id diverso e pagina", async () => {
    gh.addInstallation({ id: 7, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" });
    gh.addInstallation({ id: 8, appId: 1, accountLogin: "altra-app", accountType: "Organization", repositorySelection: "all" });
    const extra = Array.from({ length: 120 }, (_, i) => 100 + i);
    for (const id of extra) {
      gh.addInstallation({ id, appId: Number(gh.appId), accountLogin: `org${id}`, accountType: "Organization", repositorySelection: "selected" });
    }
    gh.userInstallations.set(USER_TOKEN, [7, 8, ...extra]);
    const list = await listUserInstallations(cfg, USER_TOKEN);
    expect(list).toHaveLength(121);
    expect(list[0]).toEqual({ installationId: 7, accountLogin: "ivan", accountType: "User", repositorySelection: "all" });
    expect(list.some((i) => i.installationId === 8)).toBe(false);
    expect(gh.requests.map((r) => r.path)).toEqual(["/user/installations?per_page=100&page=1", "/user/installations?per_page=100&page=2"]);
  });

  it("header comuni: Accept GitHub e versione dell'API", async () => {
    let headers: http.IncomingHttpHeaders = {};
    const srv = http.createServer((req, res) => {
      headers = req.headers;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: 1, login: "x", name: null, avatar_url: null }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      await getGithubUser({ ...cfg, apiBase: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` }, USER_TOKEN);
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
    expect(headers["accept"]).toBe("application/vnd.github+json");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
  });
});

describe("errori di rete", () => {
  it("server irraggiungibile: GitHub non risponde, senza URL", async () => {
    // Porta chiusa: un server avviato e subito spento
    const srv = http.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const dead = { ...cfg, apiBase: `http://127.0.0.1:${port}`, webBase: `http://127.0.0.1:${port}` };
    await expectGithubError(getGithubUser(dead, USER_TOKEN), UNAVAILABLE, null);
    await expectGithubError(exchangeCode(dead, "codice", "verifier"), UNAVAILABLE, null);
    await expectGithubError(installationToken(dead, 7), UNAVAILABLE, null);
  });
});

describe("/auth/me: githubEnabled", () => {
  const KEYS = ["AUTH_DISABLED", ...Object.keys(envFor({} as FakeGithub))];
  const saved: Record<string, string | undefined> = {};
  let server: http.Server;
  let base: string;
  let resetGithubConfigForTests: () => void;

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env["AUTH_DISABLED"] = "true";
    const auth = await import("../auth");
    ({ resetGithubConfigForTests } = await import("./config"));
    const app = express();
    app.use(auth.sessionMiddleware());
    app.use("/api", auth.authRouter());
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    process.env["AUTH_DISABLED"] = "true";
    resetGithubConfigForTests();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  });

  async function githubEnabled(): Promise<unknown> {
    const res = await fetch(`${base}/api/auth/me`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { githubEnabled: unknown }).githubEnabled;
  }

  it("GitHub non configurato: false", async () => {
    for (const k of Object.keys(envFor(gh))) delete process.env[k];
    resetGithubConfigForTests();
    expect(await githubEnabled()).toBe(false);
  });

  it("GitHub configurato: true", async () => {
    Object.assign(process.env, envFor(gh));
    resetGithubConfigForTests();
    expect(await githubEnabled()).toBe(true);
  });
});

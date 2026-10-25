import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type ErrorRequestHandler } from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, githubInstallationsTable, pool, userIdentitiesTable, usersTable } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import type { GithubConfig } from "./config";

// Login, collegamento e scollegamento con GitHub contro il finto GitHub: il flusso passa davvero
// dalla pagina di autorizzazione (state e PKCE S256 generati dalla route) fino alla callback.
// auth.ts legge la configurazione all'import: le variabili si impostano prima dell'import dinamico.

const ENV: Record<string, string> = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: "segreto-sessione",
  ALLOWED_EMAILS: "ivan@example.com,secondaria@example.com",
};
const ENV_KEYS = [...Object.keys(ENV), "PUBLIC_APP_URL", "AUTH_DISABLED"];
const saved: Record<string, string | undefined> = {};

const TOKEN_IVAN = "ghu_TOKEN_IVAN";
const TOKEN_ALTRO = "ghu_TOKEN_ALTRO";
const TOKEN_ESTRANEO = "ghu_TOKEN_ESTRANEO";
const TOKEN_NON_VERIFICATO = "ghu_TOKEN_NON_VERIFICATO";
const TOKEN_SECONDARIA = "ghu_TOKEN_SECONDARIA";

let gh: FakeGithub;
let cfg: GithubConfig;
let server: http.Server;
let base: string;
let users: typeof import("../users");

/** Client con un cookie jar minimo (solo casello.sid), senza seguire i redirect. */
class Client {
  cookie: string | null = null;

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    const res = await fetch(url.startsWith("http") ? url : `${base}${url}`, { ...init, headers, redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    const m = setCookie ? /casello\.sid=[^;]*/.exec(setCookie) : null;
    if (m) this.cookie = m[0];
    return res;
  }

  /** Entra come un utente esistente (route di sola prova). */
  async loginAs(userId: number): Promise<void> {
    const res = await this.request(`/test/login-as/${userId}`, { method: "POST" });
    expect(res.status).toBe(204);
  }

  /**
   * Percorre il flusso: route di partenza → authorize del finto GitHub (che approva come
   * `gh.authorizeAs`) → callback con code e state. Restituisce il redirect finale.
   */
  async flow(start: string): Promise<{ location: string; authorizeUrl: URL }> {
    const startRes = await this.request(start);
    expect(startRes.status).toBe(302);
    const authorizeUrl = new URL(startRes.headers.get("location")!);
    const authRes = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authRes.status).toBe(302);
    const callback = authRes.headers.get("location")!;
    const cbRes = await this.request(callback);
    expect(cbRes.status).toBe(302);
    return { location: cbRes.headers.get("location")!, authorizeUrl };
  }

  async me(): Promise<Response> {
    return this.request("/test/me");
  }
}

function tokenRequests(): number {
  return gh.requests.filter((r) => r.host === "web" && r.path === "/login/oauth/access_token").length;
}

async function installationsOf(userId: number): Promise<number[]> {
  const rows = await db
    .select({ installationId: githubInstallationsTable.installationId })
    .from(githubInstallationsTable)
    .where(eq(githubInstallationsTable.userId, userId));
  return rows.map((r) => r.installationId).sort((a, b) => a - b);
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env["AUTH_DISABLED"];
  Object.assign(process.env, ENV);

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

  // La porta serve prima dell'import (PUBLIC_APP_URL è il redirect_uri della callback)
  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env["PUBLIC_APP_URL"] = base;

  const auth = await import("../auth");
  const { githubAuthRouter } = await import("./oauth-routes");
  users = await import("../users");

  const app = express();
  app.use(auth.sessionMiddleware());
  app.use(express.json());
  app.post("/test/login-as/:id", (req, res) => {
    req.session.userId = Number(req.params.id);
    req.session.save(() => res.status(204).end());
  });
  app.get("/test/me", (req, res) => {
    res.json({ userId: req.session.userId ?? null, user: req.session.user ?? null, github: req.session.github ?? null });
  });
  app.use("/api", githubAuthRouter(cfg, { publicAppUrl: base }));
  const onError: ErrorRequestHandler = (_err, _req, res, _next) => {
    res.status(500).json({ error: "errore" });
  };
  app.use(onError);
  server.on("request", app);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await gh.close();
  await pool.query("TRUNCATE users, sessions RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, sessions RESTART IDENTITY CASCADE");
  gh.requests.length = 0;
  gh.codes.clear();
  gh.users.clear();
  gh.emails.clear();
  gh.userInstallations.clear();
  gh.installations.clear();
  gh.authorizeAs = null;

  gh.addInstallation({ id: 501, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" });
  gh.addInstallation({ id: 502, appId: Number(gh.appId), accountLogin: "derga", accountType: "Organization", repositorySelection: "selected" });
  gh.addInstallation({ id: 900, appId: 1, accountLogin: "ivan", accountType: "User", repositorySelection: "all" });

  gh.addUser(TOKEN_IVAN, { id: 1001, login: "ivan-gh", name: "Ivan", avatarUrl: "https://avatars.example/ivan" }, {
    emails: [
      { email: "Ivan@Example.com", verified: true, primary: true },
      { email: "vecchia@example.com", verified: true, primary: false },
    ],
    installations: [501, 502, 900],
  });
  gh.addUser(TOKEN_ALTRO, { id: 2002, login: "altro-gh", name: null, avatarUrl: null }, {
    emails: [{ email: "secondaria@example.com", verified: true, primary: true }],
    installations: [],
  });
  gh.addUser(TOKEN_ESTRANEO, { id: 3003, login: "estraneo", name: null, avatarUrl: null }, {
    emails: [{ email: "estraneo@example.com", verified: true, primary: true }],
  });
  // L'email ammessa c'è, ma non è verificata
  gh.addUser(TOKEN_NON_VERIFICATO, { id: 4004, login: "nonverificato", name: null, avatarUrl: null }, {
    emails: [{ email: "ivan@example.com", verified: false, primary: true }],
  });
  // Primaria non ammessa, secondaria verificata e ammessa
  gh.addUser(TOKEN_SECONDARIA, { id: 5005, login: "secondaria-gh", name: null, avatarUrl: null }, {
    emails: [
      { email: "personale@example.com", verified: true, primary: true },
      { email: "secondaria@example.com", verified: true, primary: false },
    ],
    installations: [501],
  });
});

describe("GET /auth/github/login", () => {
  it("redirect all'authorize di GitHub con state, PKCE S256 e redirect_uri su PUBLIC_APP_URL, senza scope", async () => {
    const client = new Client();
    const res = await client.request("/api/auth/github/login?returnTo=/runs/3");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(`${url.origin}${url.pathname}`).toBe(`${gh.webBase}/login/oauth/authorize`);
    expect(url.searchParams.get("client_id")).toBe(gh.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(`${base}/api/auth/github/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")!.length).toBeGreaterThanOrEqual(32);
    expect(url.searchParams.has("scope")).toBe(false);

    const session = (await (await client.me()).json()) as { github: { state: string; mode: string; returnTo: string } };
    expect(session.github).toMatchObject({ state: url.searchParams.get("state"), mode: "login", returnTo: "/runs/3" });
  });

  it("returnTo con barra rovesciata (/\\evil.com): dopo il login si torna a /", async () => {
    gh.authorizeAs = TOKEN_IVAN;
    const client = new Client();
    const { location } = await client.flow(`/api/auth/github/login?returnTo=${encodeURIComponent("/\\evil.com")}`);
    expect(location).toBe("/");
  });

  it("returnTo esterno: ignorato", async () => {
    const client = new Client();
    await client.request("/api/auth/github/login?returnTo=//evil.example/x");
    const session = (await (await client.me()).json()) as { github: { returnTo: string } };
    expect(session.github.returnTo).toBe("/");
  });
});

describe("login con GitHub", () => {
  it("email ammessa: sessione con userId, identità salvata, installazioni dell'App sincronizzate", async () => {
    gh.authorizeAs = TOKEN_IVAN;
    const client = new Client();
    const { location } = await client.flow("/api/auth/github/login?returnTo=/apps/2");
    expect(location).toBe("/apps/2");

    const [user] = await db.select().from(usersTable);
    expect(user).toMatchObject({ email: "ivan@example.com", name: "Ivan", picture: "https://avatars.example/ivan" });
    const identities = await db.select().from(userIdentitiesTable);
    expect(identities).toEqual([
      expect.objectContaining({ userId: user!.id, provider: "github", providerUserId: "1001", username: "ivan-gh", email: "ivan@example.com" }),
    ]);
    // Solo le installazioni di questa App (la 900 è di un'altra)
    expect(await installationsOf(user!.id)).toEqual([501, 502]);
    const [org] = await db.select().from(githubInstallationsTable).where(eq(githubInstallationsTable.installationId, 502));
    expect(org).toMatchObject({ accountLogin: "derga", accountType: "Organization", repositorySelection: "selected" });

    const session = (await (await client.me()).json()) as { userId: number; user: unknown; github: unknown };
    expect(session).toEqual({
      userId: user!.id,
      user: { email: "ivan@example.com", name: "Ivan", picture: "https://avatars.example/ivan" },
      github: null,
    });
    // PKCE verificato davvero dal finto GitHub; il verifier non è mai nell'URL
    expect(tokenRequests()).toBe(1);
  });

  it("la sessione viene rigenerata: lo state del login non è riutilizzabile", async () => {
    gh.authorizeAs = TOKEN_IVAN;
    const client = new Client();
    const start = await client.request("/api/auth/github/login");
    const cookieBefore = client.cookie;
    expect(cookieBefore).not.toBeNull();
    const authRes = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const callback = authRes.headers.get("location")!;
    const first = await client.request(callback);
    expect(first.headers.get("location")).toBe("/");
    // Nuovo id di sessione (contro la session fixation)
    expect(client.cookie).not.toBe(cookieBefore);
    // Stessa callback ripetuta: state già consumato, nessun nuovo scambio; la sessione c'è → collegamento
    const replay = await client.request(callback);
    expect(replay.headers.get("location")).toBe("/api/auth/github/link?returnTo=/account");
    expect(tokenRequests()).toBe(1);
  });

  it("email non ammessa: /?auth=denied, nessun utente creato", async () => {
    gh.authorizeAs = TOKEN_ESTRANEO;
    const client = new Client();
    const { location } = await client.flow("/api/auth/github/login");
    expect(location).toMatch(/^\/\?auth=denied/);
    expect(await db.select().from(usersTable)).toHaveLength(0);
    expect(await db.select().from(githubInstallationsTable)).toHaveLength(0);
    expect(((await (await client.me()).json()) as { userId: unknown }).userId).toBeNull();
  });

  it("email ammessa ma non verificata: /?auth=denied, nessun utente creato", async () => {
    gh.authorizeAs = TOKEN_NON_VERIFICATO;
    const client = new Client();
    const { location } = await client.flow("/api/auth/github/login");
    expect(location).toMatch(/^\/\?auth=denied/);
    expect(await db.select().from(usersTable)).toHaveLength(0);
  });

  it("utente Google esistente con la stessa email: stessa riga users", async () => {
    const google = await users.resolveLogin({
      provider: "google",
      providerUserId: "google-sub-1",
      emails: ["ivan@example.com"],
      primaryEmail: "ivan@example.com",
      username: null,
      name: "Ivan G",
      picture: null,
    });
    gh.authorizeAs = TOKEN_IVAN;
    const client = new Client();
    await client.flow("/api/auth/github/login");
    const all = await db.select().from(usersTable);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(google.id);
    const providers = (await db.select().from(userIdentitiesTable)).map((i) => i.provider).sort();
    expect(providers).toEqual(["github", "google"]);
    expect(((await (await client.me()).json()) as { userId: number }).userId).toBe(google.id);
  });

  it("installazione non più visibile al secondo login: rimossa, le altre aggiornate", async () => {
    gh.authorizeAs = TOKEN_IVAN;
    await new Client().flow("/api/auth/github/login");
    const [user] = await db.select().from(usersTable);
    expect(await installationsOf(user!.id)).toEqual([501, 502]);

    gh.userInstallations.set(TOKEN_IVAN, [502]);
    gh.installations.get(502)!.repositorySelection = "all";
    await new Client().flow("/api/auth/github/login");
    expect(await installationsOf(user!.id)).toEqual([502]);
    const [org] = await db.select().from(githubInstallationsTable);
    expect(org!.repositorySelection).toBe("all");
  });

  it("utente annullato su GitHub (access_denied): nessuno scambio, ritorno con github=cancelled", async () => {
    const client = new Client();
    const start = await client.request("/api/auth/github/login?returnTo=/apps");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await client.request(`/api/auth/github/callback?error=access_denied&state=${state}`);
    expect(res.headers.get("location")).toBe("/apps?github=cancelled");
    expect(tokenRequests()).toBe(0);
  });

  it("sincronizzazione delle installazioni fallita: il login riesce comunque, nessuna installazione", async () => {
    gh.authorizeAs = TOKEN_IVAN;
    gh.failWith = (r) => (r.path.startsWith("/user/installations") ? 500 : null);
    const client = new Client();
    try {
      const { location } = await client.flow("/api/auth/github/login?returnTo=/apps");
      expect(location).toBe("/apps");
    } finally {
      gh.failWith = null;
    }
    const [user] = await db.select().from(usersTable);
    expect(((await (await client.me()).json()) as { userId: number }).userId).toBe(user!.id);
    expect(await db.select().from(githubInstallationsTable)).toHaveLength(0);
  });

  it("GitHub non risponde allo scambio: /?auth=error, nessun utente", async () => {
    gh.authorizeAs = TOKEN_IVAN;
    gh.failWith = (r) => (r.path === "/login/oauth/access_token" ? 502 : null);
    try {
      const { location } = await new Client().flow("/api/auth/github/login");
      expect(location).toBe("/?auth=error");
    } finally {
      gh.failWith = null;
    }
    expect(await db.select().from(usersTable)).toHaveLength(0);
  });
});

describe("callback senza state valido (Review Focus 2)", () => {
  it("code senza state e senza sessione: /?auth=error e nessuno scambio del codice", async () => {
    gh.addCode("code-rubato", TOKEN_IVAN);
    const res = await new Client().request("/api/auth/github/callback?code=code-rubato&installation_id=501&setup_action=install");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?auth=error");
    expect(tokenRequests()).toBe(0);
    expect(await db.select().from(usersTable)).toHaveLength(0);
  });

  it("code con state diverso da quello in sessione: nessuno scambio, state consumato", async () => {
    gh.addCode("code-rubato", TOKEN_IVAN);
    const client = new Client();
    await client.request("/api/auth/github/login");
    const res = await client.request("/api/auth/github/callback?code=code-rubato&state=state-dell-attaccante");
    expect(res.headers.get("location")).toBe("/?auth=error");
    expect(tokenRequests()).toBe(0);
    expect(((await (await client.me()).json()) as { github: unknown }).github).toBeNull();
  });

  it("code senza state con sessione Casello (ritorno dall'installazione): si riparte dal collegamento", async () => {
    const user = await users.ensureUserByEmail("ivan@example.com");
    gh.addCode("code-installazione", TOKEN_IVAN);
    const client = new Client();
    await client.loginAs(user.id);
    const res = await client.request("/api/auth/github/callback?code=code-installazione&installation_id=501&setup_action=install");
    expect(res.headers.get("location")).toBe("/api/auth/github/link?returnTo=/account");
    expect(tokenRequests()).toBe(0);
    // L'installation_id dell'URL non è mai usato
    expect(await db.select().from(githubInstallationsTable)).toHaveLength(0);

    // Il collegamento ripartito completa il flusso con un nuovo state
    gh.authorizeAs = TOKEN_IVAN;
    const { location } = await client.flow("/api/auth/github/link?returnTo=/account");
    expect(location).toBe("/account");
    expect(await installationsOf(user.id)).toEqual([501, 502]);
  });
});

describe("collegamento da loggato", () => {
  it("senza sessione: 401", async () => {
    const res = await new Client().request("/api/auth/github/link");
    expect(res.status).toBe(401);
  });

  it("collega l'account GitHub all'utente corrente senza controllare ALLOWED_EMAILS e sincronizza", async () => {
    const user = await users.ensureUserByEmail("ivan@example.com");
    gh.authorizeAs = TOKEN_ESTRANEO;
    gh.userInstallations.set(TOKEN_ESTRANEO, [502]);
    const client = new Client();
    await client.loginAs(user.id);
    const cookie = client.cookie;
    const { location, authorizeUrl } = await client.flow("/api/auth/github/link?returnTo=/account");
    expect(location).toBe("/account");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    // Il collegamento non rigenera la sessione
    expect(client.cookie).toBe(cookie);
    expect(await db.select().from(usersTable)).toHaveLength(1);
    expect(await db.select().from(userIdentitiesTable)).toEqual([
      expect.objectContaining({ userId: user.id, provider: "github", providerUserId: "3003", username: "estraneo" }),
    ]);
    expect(await installationsOf(user.id)).toEqual([502]);
  });

  it("account GitHub già di un altro utente: /account?github=conflict e nessuna modifica", async () => {
    gh.authorizeAs = TOKEN_IVAN;
    await new Client().flow("/api/auth/github/login");
    const [owner] = await db.select().from(usersTable);
    const ownerInstallations = await installationsOf(owner!.id);

    const other = await users.ensureUserByEmail("secondaria@example.com");
    const client = new Client();
    await client.loginAs(other.id);
    const { location } = await client.flow("/api/auth/github/link?returnTo=/account");
    expect(location).toBe("/account?github=conflict");

    const identities = await db.select().from(userIdentitiesTable);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ userId: owner!.id, providerUserId: "1001" });
    expect(await installationsOf(other.id)).toEqual([]);
    expect(await installationsOf(owner!.id)).toEqual(ownerInstallations);
    expect(((await (await client.me()).json()) as { userId: number }).userId).toBe(other.id);
  });
});

describe("DELETE /auth/github", () => {
  it("senza sessione: 401", async () => {
    const res = await new Client().request("/api/auth/github", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("unica identità (email primaria non ammessa): 409 con messaggio italiano, nulla cambia", async () => {
    gh.authorizeAs = TOKEN_SECONDARIA;
    const client = new Client();
    await client.flow("/api/auth/github/login");
    const [user] = await db.select().from(usersTable);
    expect(user!.email).toBe("personale@example.com");

    const res = await client.request("/api/auth/github", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "non puoi scollegare l'unico accesso del tuo account" });
    expect(await db.select().from(userIdentitiesTable)).toHaveLength(1);
    expect(await installationsOf(user!.id)).toEqual([501]);
  });

  it("con anche Google: 204, identità GitHub e installazioni dell'utente eliminate", async () => {
    const google = await users.resolveLogin({
      provider: "google",
      providerUserId: "google-sub-1",
      emails: ["ivan@example.com"],
      primaryEmail: "ivan@example.com",
      username: null,
      name: null,
      picture: null,
    });
    gh.authorizeAs = TOKEN_IVAN;
    const client = new Client();
    await client.flow("/api/auth/github/login");
    expect(await installationsOf(google.id)).toEqual([501, 502]);

    const res = await client.request("/api/auth/github", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await db.select().from(userIdentitiesTable)).map((i) => i.provider)).toEqual(["google"]);
    expect(await installationsOf(google.id)).toEqual([]);
  });
});

import { createHash, generateKeyPairSync, randomBytes, verify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Finto GitHub per i test: API REST (`apiBase`) e sito web (`webBase`, OAuth) su due porte locali.
 * Lo stato è modificabile direttamente dai test. Riproduce le forme JSON reali di GitHub per le sole
 * chiamate usate da Casello: token di installazione (JWT RS256 verificato), utente, email,
 * installazioni, repository di un'installazione, installazione di un repo, zipball (per branch) e scambio del
 * codice OAuth (con PKCE S256 facoltativo).
 */

export interface FakeGithubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface FakeGithubEmail {
  email: string;
  verified: boolean;
  primary: boolean;
}

export interface FakeGithubInstallation {
  id: number;
  /** `app_id` restituito da GitHub: un valore diverso da `appId` simula l'installazione di un'altra App. */
  appId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
}

export interface FakeGithubRepo {
  /** proprietario/nome */
  fullName: string;
  defaultBranch: string;
  private: boolean;
  /** Branch oltre al default che lo zipball accetta come ref (default: solo `defaultBranch`). */
  branches?: string[];
}

export interface FakeGithubCode {
  /** Token utente restituito dallo scambio. */
  userToken: string;
  /** Se presente, lo scambio richiede un `code_verifier` con S256(verifier) = challenge. */
  codeChallenge?: string;
}

export interface FakeGithubIssuedToken {
  installationId: number;
  /** Nomi completi dei repo a cui il token è ristretto; null = tutti quelli dell'installazione. */
  repositories: string[] | null;
  permissions: Record<string, string>;
  expiresAt: number;
}

export interface FakeGithubRequest {
  /** Quale dei due server ha ricevuto la richiesta. */
  host: "api" | "web";
  method: string;
  /** Percorso con query string, es. `/user/installations?per_page=100&page=1`. */
  path: string;
  /** Corpo JSON (client_secret e code_verifier sostituiti con `***`), null se assente. */
  body: unknown;
  /** Header Authorization così come ricevuto. */
  auth: string | undefined;
  /** Header Accept così come ricevuto. */
  accept: string | undefined;
}

export interface FakeGithub {
  apiBase: string;
  webBase: string;
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  /** Chiave privata dell'App in PEM PKCS#1 ("BEGIN RSA PRIVATE KEY"), come la dà GitHub. */
  privateKeyPem: string;
  publicKey: KeyObject;
  /** Token utente → utente. */
  users: Map<string, FakeGithubUser>;
  /** Token utente → email. */
  emails: Map<string, FakeGithubEmail[]>;
  /** Token utente → id delle installazioni visibili all'utente. */
  userInstallations: Map<string, number[]>;
  /** Id → installazione. */
  installations: Map<number, FakeGithubInstallation>;
  /** Id installazione → repo accessibili. */
  repos: Map<number, FakeGithubRepo[]>;
  /** Codici OAuth validi (monouso). */
  codes: Map<string, FakeGithubCode>;
  /** Installazioni revocate: 404 sui token, 401 con i token già emessi. */
  revoked: Set<number>;
  /** Token di installazione emessi. */
  issuedTokens: Map<string, FakeGithubIssuedToken>;
  /** proprietario/nome → contenuto dello zipball (default: uno zip vuoto). */
  zipballs: Map<string, Uint8Array>;
  /** proprietario/nome → sha dell'ultimo commit di ogni branch (`GET /repos/{repo}/commits/{ref}`; senza voce: 404). */
  commits: Map<string, string>;
  /** Durata dei token di installazione emessi (default 1 h). */
  tokenTtlMs: number;
  /** Token utente con cui `/login/oauth/authorize` approva subito (null = 404). */
  authorizeAs: string | null;
  /** Se restituisce uno stato, la richiesta riceve quello (es. 500) invece della risposta normale. */
  failWith: ((req: FakeGithubRequest) => number | null) | null;
  /** Header aggiunti alle risposte forzate da `failWith` (es. `x-ratelimit-remaining: 0`). */
  failHeaders: Record<string, string>;
  requests: FakeGithubRequest[];
  /** Registra utente, email e installazioni visibili sotto il token utente indicato. */
  addUser(userToken: string, user: FakeGithubUser, opts?: { emails?: FakeGithubEmail[]; installations?: number[] }): void;
  /** Registra un'installazione con i suoi repo. */
  addInstallation(inst: FakeGithubInstallation, repos?: FakeGithubRepo[]): void;
  /** Codice OAuth valido per il token utente indicato (con PKCE se si passa il verifier). */
  addCode(code: string, userToken: string, codeVerifier?: string): void;
  close(): Promise<void>;
}

/** Zip vuoto (solo end of central directory). */
const EMPTY_ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const NOT_FOUND = { message: "Not Found", documentation_url: "https://docs.github.com/rest" };
const BAD_CREDENTIALS = { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" };

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redact(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const k of ["client_secret", "code_verifier"]) if (k in out) out[k] = "***";
  return out;
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? "";
  const m = /^(?:Bearer|token) (.+)$/.exec(h);
  return m ? m[1]! : null;
}

function pageOf<T>(items: T[], url: URL): T[] {
  const perPage = Math.min(Math.max(Number(url.searchParams.get("per_page") ?? 30) || 30, 1), 100);
  const page = Math.max(Number(url.searchParams.get("page") ?? 1) || 1, 1);
  return items.slice((page - 1) * perPage, page * perPage);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

export async function startFakeGithub(opts: { appId?: string; slug?: string } = {}): Promise<FakeGithub> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

  const fake = {
    apiBase: "",
    webBase: "",
    appId: opts.appId ?? "424242",
    slug: opts.slug ?? "casello-test",
    clientId: "Iv1.fakeclientid",
    clientSecret: "fake-client-secret-123",
    privateKeyPem,
    publicKey,
    users: new Map(),
    emails: new Map(),
    userInstallations: new Map(),
    installations: new Map(),
    repos: new Map(),
    codes: new Map(),
    revoked: new Set(),
    issuedTokens: new Map(),
    zipballs: new Map(),
    commits: new Map(),
    tokenTtlMs: 3_600_000,
    authorizeAs: null,
    failWith: null,
    failHeaders: {},
    requests: [],
    addUser(userToken, user, o = {}) {
      fake.users.set(userToken, user);
      fake.emails.set(userToken, o.emails ?? []);
      fake.userInstallations.set(userToken, o.installations ?? []);
    },
    addInstallation(inst, repos = []) {
      fake.installations.set(inst.id, inst);
      fake.repos.set(inst.id, repos);
    },
    addCode(code, userToken, codeVerifier) {
      fake.codes.set(code, codeVerifier === undefined ? { userToken } : { userToken, codeChallenge: pkceChallenge(codeVerifier) });
    },
    close: async () => {
      await closeServer(api);
      await closeServer(web);
    },
  } as FakeGithub;

  /** Verifica il JWT dell'App: firma RS256 con la chiave dell'App, `iss`, `exp` futuro, durata ≤ 10 minuti. */
  function validAppJwt(req: IncomingMessage): boolean {
    const token = bearer(req);
    const parts = token?.split(".") ?? [];
    if (parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    try {
      const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string };
      const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as { iat?: number; exp?: number; iss?: unknown };
      if (header.alg !== "RS256") return false;
      if (!verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"))) return false;
      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return false;
      if (payload.exp <= now || payload.iat > now + 60 || payload.exp - payload.iat > 600) return false;
      return String(payload.iss) === fake.appId;
    } catch {
      return false;
    }
  }

  function installationJson(inst: FakeGithubInstallation) {
    return {
      id: inst.id,
      app_id: inst.appId,
      app_slug: fake.slug,
      target_type: inst.accountType,
      account: { login: inst.accountLogin, id: inst.id * 10, type: inst.accountType },
      repository_selection: inst.repositorySelection,
      permissions: { contents: "read", metadata: "read" },
      created_at: "2026-10-01T10:00:00Z",
      updated_at: "2026-10-01T10:00:00Z",
    };
  }

  function repoJson(r: FakeGithubRepo, i: number) {
    const [owner, name] = r.fullName.split("/") as [string, string];
    return { id: 1000 + i, name, full_name: r.fullName, private: r.private, default_branch: r.defaultBranch, owner: { login: owner } };
  }

  /** Token di installazione valido (emesso, non scaduto, installazione non revocata). */
  function liveToken(req: IncomingMessage): FakeGithubIssuedToken | null {
    const t = bearer(req);
    const issued = t ? fake.issuedTokens.get(t) : undefined;
    if (!issued || issued.expiresAt <= Date.now() || fake.revoked.has(issued.installationId)) return null;
    return issued;
  }

  function reposOf(issued: FakeGithubIssuedToken): FakeGithubRepo[] {
    const all = fake.repos.get(issued.installationId) ?? [];
    return issued.repositories ? all.filter((r) => issued.repositories!.includes(r.fullName)) : all;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, body: unknown): Promise<void> {
    const method = req.method ?? "GET";
    const path = url.pathname;
    let m: RegExpExecArray | null;

    if (method === "POST" && (m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))) {
      if (!validAppJwt(req)) return send(res, 401, { message: "A JSON web token could not be decoded" });
      const id = Number(m[1]);
      const inst = fake.installations.get(id);
      if (!inst || fake.revoked.has(id) || String(inst.appId) !== fake.appId) return send(res, 404, NOT_FOUND);
      const b = (body ?? {}) as { repositories?: unknown; permissions?: Record<string, string> };
      const all = fake.repos.get(id) ?? [];
      let repositories: string[] | null = null;
      if (Array.isArray(b.repositories)) {
        repositories = [];
        for (const name of b.repositories) {
          const found = all.find((r) => r.fullName.split("/")[1] === name);
          if (!found) return send(res, 422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
          repositories.push(found.fullName);
        }
      }
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      const expiresAt = Date.now() + fake.tokenTtlMs;
      const permissions = b.permissions ?? { contents: "read", metadata: "read" };
      fake.issuedTokens.set(token, { installationId: id, repositories, permissions, expiresAt });
      return send(res, 201, {
        token,
        expires_at: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
        permissions,
        repository_selection: repositories ? "selected" : inst.repositorySelection,
        ...(repositories ? { repositories: repositories.map((fn) => repoJson(all.find((r) => r.fullName === fn)!, 0)) } : {}),
      });
    }

    if (method === "GET" && (m = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path))) {
      if (!validAppJwt(req)) return send(res, 401, { message: "A JSON web token could not be decoded" });
      const fullName = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`;
      for (const inst of fake.installations.values()) {
        if (fake.revoked.has(inst.id) || String(inst.appId) !== fake.appId) continue;
        if ((fake.repos.get(inst.id) ?? []).some((r) => r.fullName === fullName)) return send(res, 200, installationJson(inst));
      }
      return send(res, 404, NOT_FOUND);
    }

    if (method === "GET" && (m = /^\/repos\/([^/]+)\/([^/]+)\/zipball(?:\/(.+))?$/.exec(path))) {
      // Come GitHub: token revocato o scaduto → 401; repo fuori dal token o ref sconosciuto → 404
      const issued = liveToken(req);
      if (!issued) return send(res, 401, BAD_CREDENTIALS);
      const fullName = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`;
      const repo = reposOf(issued).find((r) => r.fullName === fullName);
      if (!repo) return send(res, 404, NOT_FOUND);
      const ref = m[3] === undefined ? null : decodeURIComponent(m[3]);
      if (ref !== null && ref !== repo.defaultBranch && !(repo.branches ?? []).includes(ref)) return send(res, 404, NOT_FOUND);
      res.writeHead(200, { "content-type": "application/zip" });
      res.end(Buffer.from(fake.zipballs.get(fullName) ?? EMPTY_ZIP));
      return;
    }

    if (method === "GET" && (m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/(.+)$/.exec(path))) {
      // Come lo zipball: token valido e repo nel token; ref = branch noto o HEAD
      const issued = liveToken(req);
      if (!issued) return send(res, 401, BAD_CREDENTIALS);
      const fullName = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`;
      const repo = reposOf(issued).find((r) => r.fullName === fullName);
      const ref = decodeURIComponent(m[3]!);
      const sha = fake.commits.get(fullName);
      if (!repo || !sha || (ref !== "HEAD" && ref !== repo.defaultBranch && !(repo.branches ?? []).includes(ref))) return send(res, 404, NOT_FOUND);
      if (req.headers.accept === "application/vnd.github.sha") {
        res.writeHead(200, { "content-type": "application/vnd.github.sha" });
        res.end(sha);
        return;
      }
      return send(res, 200, { sha });
    }

    if (method === "GET" && path === "/installation/repositories") {
      const issued = liveToken(req);
      if (!issued) return send(res, 401, BAD_CREDENTIALS);
      const repos = reposOf(issued);
      const inst = fake.installations.get(issued.installationId)!;
      const offset = (Math.max(Number(url.searchParams.get("page") ?? 1) || 1, 1) - 1) * Math.min(Number(url.searchParams.get("per_page") ?? 30) || 30, 100);
      return send(res, 200, {
        total_count: repos.length,
        repository_selection: inst.repositorySelection,
        repositories: pageOf(repos, url).map((r, i) => repoJson(r, offset + i)),
      });
    }

    const userToken = bearer(req);
    const user = userToken ? fake.users.get(userToken) : undefined;
    if (method === "GET" && path === "/user") {
      if (!user) return send(res, 401, BAD_CREDENTIALS);
      return send(res, 200, { id: user.id, login: user.login, name: user.name, avatar_url: user.avatarUrl, type: "User" });
    }
    if (method === "GET" && path === "/user/emails") {
      if (!user) return send(res, 401, BAD_CREDENTIALS);
      const emails = fake.emails.get(userToken!) ?? [];
      return send(res, 200, pageOf(emails, url).map((e) => ({ ...e, visibility: e.primary ? "private" : null })));
    }
    if (method === "GET" && path === "/user/installations") {
      if (!user) return send(res, 401, BAD_CREDENTIALS);
      const list = (fake.userInstallations.get(userToken!) ?? [])
        .filter((id) => !fake.revoked.has(id))
        .map((id) => fake.installations.get(id))
        .filter((i): i is FakeGithubInstallation => i !== undefined);
      return send(res, 200, { total_count: list.length, installations: pageOf(list, url).map(installationJson) });
    }

    return send(res, 404, NOT_FOUND);
  }

  async function handleWeb(req: IncomingMessage, res: ServerResponse, url: URL, body: unknown): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "POST" && url.pathname === "/login/oauth/access_token") {
      // Come GitHub: errori dello scambio con stato 200 e campo `error`
      const b = (body ?? {}) as Record<string, unknown>;
      if (b["client_id"] !== fake.clientId || b["client_secret"] !== fake.clientSecret) {
        return send(res, 200, { error: "incorrect_client_credentials", error_description: "The client_id and/or client_secret passed are incorrect." });
      }
      const code = typeof b["code"] === "string" ? fake.codes.get(b["code"]) : undefined;
      if (!code) return send(res, 200, { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
      fake.codes.delete(b["code"] as string);
      if (code.codeChallenge !== undefined) {
        const verifier = b["code_verifier"];
        if (typeof verifier !== "string" || pkceChallenge(verifier) !== code.codeChallenge) {
          return send(res, 200, { error: "invalid_grant", error_description: "The code_verifier does not match the code_challenge." });
        }
      }
      return send(res, 200, { access_token: code.userToken, token_type: "bearer", scope: "" });
    }
    if (method === "GET" && url.pathname === "/login/oauth/authorize") {
      // Approvazione immediata come `authorizeAs`: redirect alla callback con code e state
      const redirectUri = url.searchParams.get("redirect_uri");
      if (!fake.authorizeAs || !redirectUri || url.searchParams.get("client_id") !== fake.clientId) return send(res, 404, NOT_FOUND);
      const code = `code_${randomBytes(8).toString("hex")}`;
      const challenge = url.searchParams.get("code_challenge");
      fake.codes.set(code, challenge ? { userToken: fake.authorizeAs, codeChallenge: challenge } : { userToken: fake.authorizeAs });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state !== null) target.searchParams.set("state", state);
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }
    return send(res, 404, NOT_FOUND);
  }

  function makeServer(host: "api" | "web", handle: typeof handleApi): Server {
    return createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://fake.github");
        const body = await readBody(req);
        const entry: FakeGithubRequest = { host, method: req.method ?? "GET", path: url.pathname + url.search, body: redact(body), auth: req.headers.authorization, accept: req.headers.accept };
        fake.requests.push(entry);
        const forced = fake.failWith?.(entry) ?? null;
        if (forced !== null) {
          res.writeHead(forced, { "content-type": "application/json; charset=utf-8", ...fake.failHeaders });
          res.end(JSON.stringify({ message: "forced failure" }));
          return;
        }
        await handle(req, res, url, body);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  }

  const api = makeServer("api", handleApi);
  const web = makeServer("web", handleWeb);
  fake.apiBase = await listen(api);
  fake.webBase = await listen(web);
  return fake;
}

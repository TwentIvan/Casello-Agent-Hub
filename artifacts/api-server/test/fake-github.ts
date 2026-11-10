import { createHash, generateKeyPairSync, randomBytes, verify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { buildZip } from "../src/lib/zip-writer";

/**
 * Finto GitHub per i test: API REST (`apiBase`) e sito web (`webBase`, OAuth) su due porte locali.
 * Lo stato è modificabile direttamente dai test. Riproduce le forme JSON reali di GitHub per le sole
 * chiamate usate da Casello: token di installazione (JWT RS256 verificato), utente, email,
 * installazioni, repository di un'installazione, installazione di un repo, zipball (per branch), issue ed
 * etichette di un repo e scambio del codice OAuth (con PKCE S256 facoltativo).
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

export interface FakeGithubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  stateReason: string | null;
  /** ISO 8601, confrontata con `since` negli elenchi. */
  updatedAt: string;
}

export interface FakeGitTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

/** Stato Git di un repo: oggetti e riferimenti. Gli alberi sono piatti (percorsi completi con `/`). */
export interface FakeGitRepo {
  blobs: Map<string, Buffer>;
  trees: Map<string, FakeGitTreeEntry[]>;
  commits: Map<string, { tree: string; parents: string[]; message: string }>;
  /** Chiavi come `heads/main` (senza `refs/`). */
  refs: Map<string, string>;
  defaultBranch: string;
}

export interface FakePull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
}

export interface FakeCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  annotations: { path: string; start_line: number; message: string }[];
  jobId?: number;
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
  /**
   * Id installazione → permessi concessi all'App (default `contents: read`, `metadata: read`, `issues: write`).
   * Un token che chiede un permesso non concesso (o di livello superiore) riceve 422.
   */
  installationPermissions: Map<number, Record<string, string>>;
  /** proprietario/nome → issue del repo (numerate dal test o dalla creazione). */
  issues: Map<string, FakeGithubIssue[]>;
  /** proprietario/nome → nomi delle etichette esistenti. */
  labels: Map<string, Set<string>>;
  /** Repo con le issue disattivate: 410 su creazione ed elenco. */
  issuesDisabled: Set<string>;
  /** Installazioni revocate: 404 sui token, 401 con i token già emessi. */
  revoked: Set<number>;
  /** Token di installazione emessi. */
  issuedTokens: Map<string, FakeGithubIssuedToken>;
  /** proprietario/nome → contenuto dello zipball (default: uno zip vuoto). */
  zipballs: Map<string, Uint8Array>;
  /** proprietario/nome → sha dell'ultimo commit di ogni branch (`GET /repos/{repo}/commits/{ref}`; senza voce: 404). */
  commits: Map<string, string>;
  /** proprietario/nome → stato Git (Data API, zipball e commit dallo stato quando presente). */
  git: Map<string, FakeGitRepo>;
  /** proprietario/nome → pull request. */
  pulls: Map<string, FakePull[]>;
  /** sha → check run. */
  checkRuns: Map<string, FakeCheckRun[]>;
  /** sha → stati di commit. */
  statuses: Map<string, { context: string; state: string }[]>;
  /** id del job → log di testo. */
  jobLogs: Map<number, string>;
  /** Crea un repo Git con un commit iniziale sul branch dato; risponde con lo sha del commit. */
  seedRepo(fullName: string, branch: string, files: Record<string, string | { content: string; mode: string }>): string;
  /** File (percorso → testo) del commit a cui punta un branch o uno sha. */
  filesAt(fullName: string, ref: string): Record<string, string>;
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

function sha1(text: string | Buffer): string {
  return createHash("sha1").update(text).digest("hex");
}

function blobSha(content: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]));
}

function storeTree(repo: FakeGitRepo, entries: FakeGitTreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sha = sha1(`tree\n${sorted.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}`).join("\n")}`);
  repo.trees.set(sha, sorted);
  return sha;
}

function storeCommit(repo: FakeGitRepo, tree: string, parents: string[], message: string): string {
  const sha = sha1(`commit\n${tree}\n${parents.join(",")}\n${message}`);
  repo.commits.set(sha, { tree, parents, message });
  return sha;
}

/** Branch (con o senza `refs/heads/`), `HEAD` o sha completo di un commit → sha, altrimenti null. */
function resolveRef(repo: FakeGitRepo, ref: string): string | null {
  if (ref === "HEAD") return repo.refs.get(`heads/${repo.defaultBranch}`) ?? null;
  const name = ref.replace(/^refs\//, "").replace(/^heads\//, "");
  const byBranch = repo.refs.get(`heads/${name}`);
  if (byBranch) return byBranch;
  return repo.commits.has(ref) ? ref : null;
}

function isAncestor(repo: FakeGitRepo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const cur = queue.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    queue.push(...(repo.commits.get(cur)?.parents ?? []));
  }
  return false;
}

function filesOfCommit(repo: FakeGitRepo, commitSha: string): Record<string, string> {
  const out: Record<string, string> = {};
  const commit = repo.commits.get(commitSha);
  for (const e of repo.trees.get(commit?.tree ?? "") ?? []) {
    if (e.type === "blob") out[e.path] = (repo.blobs.get(e.sha) ?? Buffer.alloc(0)).toString("utf8");
  }
  return out;
}

const DEFAULT_PERMISSIONS: Record<string, string> = { contents: "read", metadata: "read", issues: "write" };
const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

const NOT_FOUND = { message: "Not Found", documentation_url: "https://docs.github.com/rest" };
const BAD_CREDENTIALS = { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" };
const NOT_ACCESSIBLE = { message: "Resource not accessible by integration", documentation_url: "https://docs.github.com/rest" };

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
    installationPermissions: new Map(),
    issues: new Map(),
    labels: new Map(),
    issuesDisabled: new Set(),
    revoked: new Set(),
    issuedTokens: new Map(),
    zipballs: new Map(),
    commits: new Map(),
    git: new Map(),
    pulls: new Map(),
    checkRuns: new Map(),
    statuses: new Map(),
    jobLogs: new Map(),
    seedRepo(fullName, branch, files) {
      const repo: FakeGitRepo = { blobs: new Map(), trees: new Map(), commits: new Map(), refs: new Map(), defaultBranch: branch };
      const entries: FakeGitTreeEntry[] = Object.entries(files).map(([path, spec]) => {
        const { content, mode } = typeof spec === "string" ? { content: spec, mode: "100644" } : spec;
        const buf = Buffer.from(content, "utf8");
        const sha = blobSha(buf);
        repo.blobs.set(sha, buf);
        return { path, mode, type: mode === "160000" ? "commit" : "blob", sha };
      });
      const tree = storeTree(repo, entries);
      const commit = storeCommit(repo, tree, [], "seed");
      repo.refs.set(`heads/${branch}`, commit);
      fake.git.set(fullName, repo);
      return commit;
    },
    filesAt(fullName, ref) {
      const repo = fake.git.get(fullName);
      const sha = repo ? resolveRef(repo, ref) : null;
      if (!repo || !sha) throw new Error(`ref sconosciuto: ${ref}`);
      return filesOfCommit(repo, sha);
    },
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
      permissions: grantedPermissions(inst.id),
      created_at: "2026-10-01T10:00:00Z",
      updated_at: "2026-10-01T10:00:00Z",
    };
  }

  function grantedPermissions(installationId: number): Record<string, string> {
    return fake.installationPermissions.get(installationId) ?? DEFAULT_PERMISSIONS;
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
      const granted = grantedPermissions(id);
      // Come GitHub: un permesso non concesso all'installazione (o di livello superiore) → 422
      for (const [name, level] of Object.entries(b.permissions ?? {})) {
        if ((LEVEL[granted[name] ?? ""] ?? 0) < (LEVEL[level] ?? Number.POSITIVE_INFINITY)) {
          return send(res, 422, { message: "The permissions requested are not granted to this installation." });
        }
      }
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      const expiresAt = Date.now() + fake.tokenTtlMs;
      const permissions = b.permissions ?? granted;
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


    // Log di un job (destinazione del redirect): senza autenticazione, come l'indirizzo firmato di GitHub
    if (method === "GET" && (m = /^\/_logs\/(\d+)$/.exec(path))) {
      const log = fake.jobLogs.get(Number(m[1]));
      if (log === undefined) return send(res, 404, NOT_FOUND);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(log);
      return;
    }

    /**
     * Controlli comuni dei percorsi `/repos/{o}/{r}/…`: token valido (401), repo dell'installazione (404),
     * repo nel token e permesso almeno al livello richiesto (403). Risponde da sé e dà null in caso di errore.
     */
    function access(permission: string, level: "read" | "write"): string | null {
      const issued = liveToken(req);
      if (!issued) {
        send(res, 401, BAD_CREDENTIALS);
        return null;
      }
      const fullName = `${decodeURIComponent(repoMatch![1]!)}/${decodeURIComponent(repoMatch![2]!)}`;
      if (!(fake.repos.get(issued.installationId) ?? []).some((r) => r.fullName === fullName)) {
        send(res, 404, NOT_FOUND);
        return null;
      }
      if (!reposOf(issued).some((r) => r.fullName === fullName) || (LEVEL[issued.permissions[permission] ?? ""] ?? 0) < LEVEL[level]!) {
        send(res, 403, NOT_ACCESSIBLE);
        return null;
      }
      return fullName;
    }
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    const rest = repoMatch?.[3] ?? "";
    const gitOf = (fullName: string): FakeGitRepo | undefined => fake.git.get(fullName);

    if (repoMatch && rest === "" && method === "GET") {
      const fullName = access("contents", "read");
      if (!fullName) return;
      const r = (fake.repos.get(liveToken(req)!.installationId) ?? []).find((x) => x.fullName === fullName)!;
      return send(res, 200, { ...repoJson(r, 0), default_branch: gitOf(fullName)?.defaultBranch ?? r.defaultBranch });
    }

    if (repoMatch && /^\/git\//.test(rest)) {
      const write = method !== "GET";
      const fullName = access("contents", write ? "write" : "read");
      if (!fullName) return;
      const repo = gitOf(fullName);
      if (!repo) return send(res, 404, NOT_FOUND);
      const b = (body ?? {}) as Record<string, unknown>;
      const refJson = (key: string) => ({ ref: `refs/${key}`, object: { sha: repo.refs.get(key)!, type: "commit" } });
      let g: RegExpExecArray | null;

      if (method === "GET" && (g = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
        const entries = repo.trees.get(g[1]!);
        if (!entries) return send(res, 404, NOT_FOUND);
        return send(res, 200, { sha: g[1], truncated: false, tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha })) });
      }
      if (method === "GET" && rest === "/git/refs") return send(res, 200, [...repo.refs.keys()].map(refJson));
      if (method === "GET" && (g = /^\/git\/refs?\/(heads\/.+)$/.exec(rest))) {
        const key = decodeURIComponent(g[1]!);
        return repo.refs.has(key) ? send(res, 200, refJson(key)) : send(res, 404, NOT_FOUND);
      }
      if (method === "POST" && rest === "/git/refs") {
        const ref = typeof b["ref"] === "string" ? b["ref"] : "";
        const sha = typeof b["sha"] === "string" ? b["sha"] : "";
        if (!/^refs\/heads\/.+/.test(ref) || !repo.commits.has(sha)) return send(res, 422, { message: "Validation Failed" });
        const key = ref.slice("refs/".length);
        if (repo.refs.has(key)) return send(res, 422, { message: "Reference already exists" });
        repo.refs.set(key, sha);
        return send(res, 201, refJson(key));
      }
      if (method === "PATCH" && (g = /^\/git\/refs\/(heads\/.+)$/.exec(rest))) {
        const key = decodeURIComponent(g[1]!);
        const current = repo.refs.get(key);
        if (!current) return send(res, 404, NOT_FOUND);
        const sha = typeof b["sha"] === "string" ? b["sha"] : "";
        if (!repo.commits.has(sha)) return send(res, 422, { message: "Object does not exist" });
        if (b["force"] !== true && !isAncestor(repo, current, sha)) return send(res, 422, { message: "Update is not a fast forward" });
        repo.refs.set(key, sha);
        return send(res, 200, refJson(key));
      }
      if (method === "POST" && rest === "/git/blobs") {
        if (typeof b["content"] !== "string") return send(res, 422, { message: "Validation Failed" });
        const buf = b["encoding"] === "base64" ? Buffer.from(b["content"], "base64") : Buffer.from(b["content"], "utf8");
        const sha = blobSha(buf);
        repo.blobs.set(sha, buf);
        return send(res, 201, { sha });
      }
      if (method === "POST" && rest === "/git/trees") {
        const base = typeof b["base_tree"] === "string" ? b["base_tree"] : null;
        if (base !== null && !repo.trees.has(base)) return send(res, 422, { message: "base_tree does not exist" });
        const entries = new Map((base ? repo.trees.get(base)! : []).map((e) => [e.path, e]));
        for (const raw of Array.isArray(b["tree"]) ? (b["tree"] as Record<string, unknown>[]) : []) {
          const p = raw["path"];
          if (typeof p !== "string" || !p) return send(res, 422, { message: "Validation Failed" });
          if (raw["sha"] === null) {
            entries.delete(p);
            continue;
          }
          if (typeof raw["sha"] !== "string" || !repo.blobs.has(raw["sha"])) return send(res, 422, { message: "tree entry sha does not exist" });
          entries.set(p, { path: p, mode: typeof raw["mode"] === "string" ? raw["mode"] : "100644", type: "blob", sha: raw["sha"] });
        }
        return send(res, 201, { sha: storeTree(repo, [...entries.values()]) });
      }
      if (method === "GET" && (g = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
        const c = repo.commits.get(g[1]!);
        if (!c) return send(res, 404, NOT_FOUND);
        return send(res, 200, { sha: g[1], message: c.message, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) });
      }
      if (method === "POST" && rest === "/git/commits") {
        const tree = typeof b["tree"] === "string" ? b["tree"] : "";
        const parents = Array.isArray(b["parents"]) ? (b["parents"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
        if (!repo.trees.has(tree) || parents.some((p) => !repo.commits.has(p)) || typeof b["message"] !== "string") {
          return send(res, 422, { message: "Validation Failed" });
        }
        const sha = storeCommit(repo, tree, parents, b["message"]);
        return send(res, 201, { sha, tree: { sha: tree }, parents: parents.map((p) => ({ sha: p })), message: b["message"] });
      }
      return send(res, 404, NOT_FOUND);
    }

    if (repoMatch && (rest === "/pulls" || /^\/pulls\/\d+$/.test(rest))) {
      const fullName = access("pull_requests", method === "GET" ? "read" : "write");
      if (!fullName) return;
      const list = fake.pulls.get(fullName) ?? [];
      fake.pulls.set(fullName, list);
      const pullJson = (p: FakePull) => {
        const headSha = gitOf(fullName)?.refs.get(`heads/${p.head}`) ?? p.headSha;
        return {
          number: p.number,
          title: p.title,
          body: p.body,
          html_url: `https://github.com/${fullName}/pull/${p.number}`,
          draft: p.draft,
          state: p.state,
          merged: p.merged,
          head: { ref: p.head, sha: headSha },
          base: { ref: p.base },
        };
      };
      if (method === "POST" && rest === "/pulls") {
        const b = (body ?? {}) as Record<string, unknown>;
        const repo = gitOf(fullName);
        const head = typeof b["head"] === "string" ? b["head"].replace(/^[^:]+:/, "") : "";
        const base = typeof b["base"] === "string" ? b["base"] : "";
        if (typeof b["title"] !== "string" || !b["title"] || !repo?.refs.has(`heads/${head}`) || !repo.refs.has(`heads/${base}`)) {
          return send(res, 422, { message: "Validation Failed" });
        }
        if (list.some((p) => p.state === "open" && p.head === head && p.base === base)) {
          return send(res, 422, { message: "A pull request already exists" });
        }
        const issueMax = (fake.issues.get(fullName) ?? []).reduce((max, i) => Math.max(max, i.number), 0);
        const pull: FakePull = {
          number: Math.max(issueMax, ...list.map((p) => p.number), 0) + 1,
          head,
          base,
          title: b["title"],
          body: typeof b["body"] === "string" ? b["body"] : "",
          draft: b["draft"] === true,
          state: "open",
          merged: false,
          headSha: repo.refs.get(`heads/${head}`)!,
        };
        list.push(pull);
        return send(res, 201, pullJson(pull));
      }
      if (method === "GET" && rest === "/pulls") {
        const state = url.searchParams.get("state") ?? "open";
        const head = url.searchParams.get("head")?.replace(/^[^:]+:/, "") ?? null;
        const base = url.searchParams.get("base");
        return send(
          res,
          200,
          pageOf(
            list.filter((p) => (state === "all" || p.state === state) && (head === null || p.head === head) && (base === null || p.base === base)),
            url,
          ).map(pullJson),
        );
      }
      if (method === "GET") {
        const pull = list.find((p) => p.number === Number(rest.split("/")[2]));
        return pull ? send(res, 200, pullJson(pull)) : send(res, 404, NOT_FOUND);
      }
    }

    if (repoMatch && method === "GET") {
      let c: RegExpExecArray | null;
      if ((c = /^\/commits\/([^/]+)\/check-runs$/.exec(rest))) {
        if (!access("checks", "read")) return;
        const runs = fake.checkRuns.get(decodeURIComponent(c[1]!)) ?? [];
        const fullName = `${decodeURIComponent(repoMatch[1]!)}/${decodeURIComponent(repoMatch[2]!)}`;
        return send(res, 200, {
          total_count: runs.length,
          check_runs: pageOf(runs, url).map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            details_url: r.jobId !== undefined ? `https://github.com/${fullName}/actions/runs/1/job/${r.jobId}` : `https://github.com/${fullName}/runs/${r.id}`,
          })),
        });
      }
      if ((c = /^\/check-runs\/(\d+)\/annotations$/.exec(rest))) {
        if (!access("checks", "read")) return;
        for (const runs of fake.checkRuns.values()) {
          const run = runs.find((r) => r.id === Number(c![1]));
          if (run) return send(res, 200, pageOf(run.annotations, url));
        }
        return send(res, 404, NOT_FOUND);
      }
      if ((c = /^\/commits\/([^/]+)\/status$/.exec(rest))) {
        if (!access("statuses", "read")) return;
        const statuses = fake.statuses.get(decodeURIComponent(c[1]!)) ?? [];
        const state = statuses.some((s) => s.state === "failure" || s.state === "error")
          ? "failure"
          : statuses.length === 0 || statuses.some((s) => s.state === "pending")
            ? "pending"
            : "success";
        return send(res, 200, { state, total_count: statuses.length, statuses: statuses.map((s) => ({ context: s.context, state: s.state })) });
      }
      if ((c = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest))) {
        if (!access("actions", "read")) return;
        if (!fake.jobLogs.has(Number(c[1]))) return send(res, 404, NOT_FOUND);
        res.writeHead(302, { location: `${fake.apiBase}/_logs/${c[1]}` }).end();
        return;
      }
      if ((c = /^\/issues\/(\d+)$/.exec(rest))) {
        const fullName = access("issues", "read");
        if (!fullName) return;
        const i = (fake.issues.get(fullName) ?? []).find((x) => x.number === Number(c![1]));
        if (!i) return send(res, 404, NOT_FOUND);
        return send(res, 200, {
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state,
          state_reason: i.stateReason,
          labels: i.labels.map((name) => ({ name })),
          updated_at: i.updatedAt,
          html_url: `https://github.com/${fullName}/issues/${i.number}`,
        });
      }
    }

    // Zipball e commit dallo stato Git, quando il repo è stato creato con `seedRepo`
    if (repoMatch && method === "GET" && (m = /^\/(zipball|commits)(?:\/(.+))?$/.exec(rest))) {
      const fullName = `${decodeURIComponent(repoMatch[1]!)}/${decodeURIComponent(repoMatch[2]!)}`;
      const repo = gitOf(fullName);
      if (repo && (m[1] === "zipball" || m[2] !== undefined)) {
        const fn = access("contents", "read");
        if (!fn) return;
        const ref = m[2] === undefined ? "HEAD" : decodeURIComponent(m[2]);
        const sha = resolveRef(repo, ref);
        if (!sha) return send(res, 404, NOT_FOUND);
        if (m[1] === "commits") {
          if (req.headers.accept === "application/vnd.github.sha") {
            res.writeHead(200, { "content-type": "application/vnd.github.sha" });
            res.end(sha);
            return;
          }
          return send(res, 200, { sha });
        }
        const top = `${fullName.replace("/", "-")}-${sha.slice(0, 7)}`;
        const files = Object.entries(filesOfCommit(repo, sha)).map(([name, content]) => ({ name: `${top}/${name}`, content: Buffer.from(content, "utf8") }));
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(buildZip(files));
        return;
      }
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

    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/(issues|labels)$/.exec(path)) && (method === "POST" || (method === "GET" && m[3] === "issues"))) {
      // Token valido; repo sconosciuto all'installazione → 404; fuori dal token o senza `issues` → 403
      const issued = liveToken(req);
      if (!issued) return send(res, 401, BAD_CREDENTIALS);
      const fullName = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`;
      if (!(fake.repos.get(issued.installationId) ?? []).some((r) => r.fullName === fullName)) return send(res, 404, NOT_FOUND);
      const needed = method === "GET" ? LEVEL["read"]! : LEVEL["write"]!;
      if (!reposOf(issued).some((r) => r.fullName === fullName) || (LEVEL[issued.permissions["issues"] ?? ""] ?? 0) < needed) {
        return send(res, 403, NOT_ACCESSIBLE);
      }
      const labels = fake.labels.get(fullName) ?? new Set<string>();
      fake.labels.set(fullName, labels);

      if (m[3] === "labels") {
        const b = (body ?? {}) as { name?: unknown };
        if (typeof b.name !== "string" || !b.name) return send(res, 422, { message: "Validation Failed" });
        if (labels.has(b.name)) return send(res, 422, { message: "Validation Failed", errors: [{ resource: "Label", code: "already_exists", field: "name" }] });
        labels.add(b.name);
        return send(res, 201, { name: b.name });
      }

      if (fake.issuesDisabled.has(fullName)) return send(res, 410, { message: "Issues are disabled for this repo" });
      const list = fake.issues.get(fullName) ?? [];
      fake.issues.set(fullName, list);

      if (method === "POST") {
        const b = (body ?? {}) as { title?: unknown; body?: unknown; labels?: unknown };
        if (typeof b.title !== "string" || !b.title.trim()) return send(res, 422, { message: "Validation Failed" });
        const names = Array.isArray(b.labels) ? b.labels.filter((l): l is string => typeof l === "string") : [];
        // Come GitHub: le etichette mancanti vengono create con l'issue
        for (const n of names) labels.add(n);
        const issue: FakeGithubIssue = {
          number: list.reduce((max, i) => Math.max(max, i.number), 0) + 1,
          title: b.title,
          body: typeof b.body === "string" ? b.body : "",
          labels: names,
          state: "open",
          stateReason: null,
          updatedAt: new Date().toISOString(),
        };
        list.push(issue);
        return send(res, 201, { number: issue.number, html_url: `https://github.com/${fullName}/issues/${issue.number}`, state: "open" });
      }

      const state = url.searchParams.get("state") ?? "open";
      const wanted = (url.searchParams.get("labels") ?? "").split(",").filter(Boolean);
      const since = url.searchParams.get("since");
      const sinceMs = since === null ? null : Date.parse(since);
      const filtered = list
        .filter((i) => state === "all" || i.state === state)
        .filter((i) => wanted.every((l) => i.labels.includes(l)))
        .filter((i) => sinceMs === null || Date.parse(i.updatedAt) >= sinceMs);
      return send(
        res,
        200,
        pageOf(filtered, url).map((i) => ({
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state,
          state_reason: i.stateReason,
          labels: i.labels.map((name) => ({ name })),
          updated_at: i.updatedAt,
          html_url: `https://github.com/${fullName}/issues/${i.number}`,
        })),
      );
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

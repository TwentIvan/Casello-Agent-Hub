import { createPrivateKey, sign } from "node:crypto";
import { isValidGithubRepo } from "../architect/sources";
import { readBytesLimited } from "../http-read";
import { logger } from "../logger";
import type { GithubConfig } from "./config";

/**
 * Client della GitHub App "Casello": JWT dell'App (RS256 con `node:crypto`), token di installazione
 * (ristretti al repo e in cache solo in memoria), scambio del codice OAuth e letture con il token
 * dell'utente. Gli errori hanno testi fissi: mai URL, codici, token o chiave nei messaggi.
 */

export const GITHUB_MESSAGES = {
  notConfigured: "GitHub non configurato",
  noAccess: "l'App Casello non ha più accesso a questo repository: reinstallala o scegli un altro repo",
  unavailable: "GitHub non risponde (riprova più tardi)",
  loginFailed: "accesso con GitHub non riuscito",
} as const;

export class GithubError extends Error {
  /** Stato HTTP della risposta di GitHub, null per errori di rete o di configurazione. */
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "GithubError";
    this.status = status;
  }
}

const TIMEOUT_MS = 15_000;
const MAX_JSON_BYTES = 1_048_576;
const API_VERSION = "2022-11-28";
const PER_PAGE = 100;
const MAX_REPOS = 1000;
/** Tetto di pagine per ogni elenco paginato: un upstream che risponde sempre con elementi scartati non fa girare il ciclo all'infinito. */
const MAX_PAGES = 10;
const JWT_BACKDATE_S = 60;
const JWT_TTL_S = 540;
/** Un token di installazione in cache si riusa solo se scade fra più di 5 minuti. */
const TOKEN_MIN_REMAINING_MS = 5 * 60_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- JWT dell'App ------------------------------------------------------------------------

/** JWT RS256 dell'App: `iat` = ora − 60 s (orologi sfasati), `exp` = ora + 540 s, `iss` = appId. */
export function appJwt(cfg: GithubConfig, now: () => number = Date.now): string {
  const t = Math.floor(now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: t - JWT_BACKDATE_S, exp: t + JWT_TTL_S, iss: cfg.appId })).toString("base64url");
  const data = `${header}.${payload}`;
  let signature: Buffer;
  try {
    signature = sign("sha256", Buffer.from(data), createPrivateKey(cfg.privateKey));
  } catch {
    // Chiave illeggibile: mai ripeterla né riportare l'errore di OpenSSL
    throw new GithubError(GITHUB_MESSAGES.notConfigured, null);
  }
  return `${data}.${signature.toString("base64url")}`;
}

// --- HTTP --------------------------------------------------------------------------------

interface CallResult {
  status: number;
  /** Corpo JSON delle risposte 2xx; null per gli altri stati (il corpo non viene letto). */
  json: unknown;
}

/**
 * Chiamata a GitHub con timeout, senza redirect e con corpo limitato. Errori di rete, 5xx, 429,
 * corpi troppo grandi o non JSON → "GitHub non risponde"; gli altri stati li interpreta il chiamante.
 */
async function call(
  cfg: GithubConfig,
  input: { base: "api" | "web"; method: "GET" | "POST"; path: string; token?: string; body?: unknown },
): Promise<CallResult> {
  const url = `${input.base === "api" ? cfg.apiBase : cfg.webBase}${input.path}`;
  const headers: Record<string, string> = {
    accept: input.base === "api" ? "application/vnd.github+json" : "application/json",
    "x-github-api-version": API_VERSION,
    "user-agent": "casello",
  };
  if (input.token !== undefined) headers["authorization"] = `Bearer ${input.token}`;
  if (input.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GithubError(GITHUB_MESSAGES.unavailable, null);
  }
  if (res.status >= 500 || res.status === 429 || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    throw new GithubError(GITHUB_MESSAGES.unavailable, res.status);
  }
  // 403 per limite di richieste (primario o secondario): GitHub non è disponibile, non è un rifiuto di accesso
  if (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))) {
    await res.body?.cancel().catch(() => {});
    throw new GithubError(GITHUB_MESSAGES.unavailable, 403);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, json: null };
  }
  try {
    const bytes = await readBytesLimited(res, MAX_JSON_BYTES);
    return { status: res.status, json: JSON.parse(new TextDecoder("utf-8").decode(bytes)) as unknown };
  } catch {
    throw new GithubError(GITHUB_MESSAGES.unavailable, res.status);
  }
}

/** Risposta 2xx con una forma inattesa: trattata come GitHub non disponibile. */
function badShape(status: number): GithubError {
  return new GithubError(GITHUB_MESSAGES.unavailable, status);
}

// --- Token di installazione --------------------------------------------------------------

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Solo per i test. */
export function clearInstallationTokenCache(): void {
  tokenCache.clear();
}

/** Scarta i token in cache di un'installazione (dopo un 401/404: accesso revocato). */
export function forgetInstallationTokens(installationId: number): void {
  for (const key of tokenCache.keys()) if (key.startsWith(`${installationId}:`)) tokenCache.delete(key);
}

/**
 * 401 su una chiamata firmata con il JWT dell'App: GitHub rifiuta le credenziali dell'App stessa
 * (chiave sbagliata, orologio sfasato), non l'installazione. Non è una revoca: "GitHub non risponde".
 */
function appCredentialsRejected(): GithubError {
  logger.warn("credenziali dell'App GitHub rifiutate");
  return new GithubError(GITHUB_MESSAGES.unavailable, 401);
}

function noAccess(installationId: number, status: number | null): GithubError {
  forgetInstallationTokens(installationId);
  return new GithubError(GITHUB_MESSAGES.noAccess, status);
}

/**
 * Token di installazione; con `scope` ristretto a quel repo ("proprietario/nome") e a
 * `contents: read`. Resta in memoria per (installazione, repo) fino a 5 minuti prima della scadenza.
 */
export async function installationToken(cfg: GithubConfig, installationId: number, scope?: { repo: string }): Promise<string> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw noAccess(installationId, null);
  if (scope && !isValidGithubRepo(scope.repo)) throw noAccess(installationId, null);
  const key = `${installationId}:${scope?.repo ?? "*"}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - Date.now() > TOKEN_MIN_REMAINING_MS) return hit.token;

  const body = scope ? { repositories: [scope.repo.split("/")[1]!], permissions: { contents: "read" } } : undefined;
  const { status, json } = await call(cfg, {
    base: "api",
    method: "POST",
    path: `/app/installations/${installationId}/access_tokens`,
    token: appJwt(cfg),
    body,
  });
  if (status === 401) throw appCredentialsRejected();
  // 404: installazione rimossa o sconosciuta; 403/422: repo non visibile all'installazione
  if (status >= 400) throw noAccess(installationId, status);
  if (!isObj(json) || typeof json["token"] !== "string" || !json["token"]) throw badShape(status);
  const token = json["token"];
  const expiresAt = typeof json["expires_at"] === "string" ? Date.parse(json["expires_at"]) : Number.NaN;
  if (Number.isFinite(expiresAt)) tokenCache.set(key, { token, expiresAt });
  else tokenCache.delete(key);
  return token;
}

/** `GET /repos/{owner}/{repo}/installation` con il JWT dell'App: id dell'installazione, null se il repo non è raggiungibile. */
export async function repoInstallationId(cfg: GithubConfig, repo: string): Promise<number | null> {
  if (!isValidGithubRepo(repo)) return null;
  const [owner, name] = repo.split("/") as [string, string];
  const { status, json } = await call(cfg, {
    base: "api",
    method: "GET",
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
    token: appJwt(cfg),
  });
  if (status === 404) return null;
  if (status === 401) throw appCredentialsRejected();
  if (status >= 400) throw new GithubError(GITHUB_MESSAGES.noAccess, status);
  if (!isObj(json) || typeof json["id"] !== "number") throw badShape(status);
  return json["id"];
}

/** Repository visibili a un'installazione (paginati, al massimo 1000). */
export async function listInstallationRepos(
  cfg: GithubConfig,
  installationId: number,
): Promise<{ fullName: string; defaultBranch: string; private: boolean }[]> {
  const token = await installationToken(cfg, installationId);
  const out: { fullName: string; defaultBranch: string; private: boolean }[] = [];
  for (let page = 1; page <= MAX_PAGES && out.length < MAX_REPOS; page++) {
    const { status, json } = await call(cfg, {
      base: "api",
      method: "GET",
      path: `/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
      token,
    });
    if (status >= 400) throw noAccess(installationId, status);
    if (!isObj(json) || !Array.isArray(json["repositories"])) throw badShape(status);
    const repos = json["repositories"] as unknown[];
    for (const r of repos) {
      if (!isObj(r) || typeof r["full_name"] !== "string") continue;
      out.push({
        fullName: r["full_name"],
        defaultBranch: typeof r["default_branch"] === "string" ? r["default_branch"] : "main",
        private: r["private"] === true,
      });
    }
    if (repos.length < PER_PAGE) break;
  }
  return out.slice(0, MAX_REPOS);
}

// --- OAuth e token dell'utente -----------------------------------------------------------

/** Scambio del codice OAuth (con PKCE se c'è il verifier): restituisce il token dell'utente, da usare e scartare. */
export async function exchangeCode(cfg: GithubConfig, code: string, codeVerifier: string | null): Promise<string> {
  const body: Record<string, string> = { client_id: cfg.clientId, client_secret: cfg.clientSecret, code };
  if (codeVerifier !== null) body["code_verifier"] = codeVerifier;
  const { status, json } = await call(cfg, { base: "web", method: "POST", path: "/login/oauth/access_token", body });
  if (status >= 400) throw new GithubError(GITHUB_MESSAGES.loginFailed, status);
  // GitHub risponde 200 con `error` per un codice non valido o scaduto
  if (!isObj(json) || typeof json["access_token"] !== "string" || !json["access_token"]) {
    throw new GithubError(GITHUB_MESSAGES.loginFailed, 400);
  }
  return json["access_token"];
}

async function userGet(cfg: GithubConfig, userToken: string, path: string): Promise<{ status: number; json: unknown }> {
  const res = await call(cfg, { base: "api", method: "GET", path, token: userToken });
  if (res.status >= 400) throw new GithubError(GITHUB_MESSAGES.loginFailed, res.status);
  return res;
}

export async function getGithubUser(
  cfg: GithubConfig,
  userToken: string,
): Promise<{ id: string; login: string; name: string | null; avatarUrl: string | null }> {
  const { status, json } = await userGet(cfg, userToken, "/user");
  if (!isObj(json) || typeof json["id"] !== "number" || typeof json["login"] !== "string") throw badShape(status);
  return {
    id: String(json["id"]),
    login: json["login"],
    name: typeof json["name"] === "string" && json["name"] ? json["name"] : null,
    avatarUrl: typeof json["avatar_url"] === "string" && json["avatar_url"] ? json["avatar_url"] : null,
  };
}

/** Solo le email verificate, in minuscolo; `primary` è la principale se verificata. */
export async function getVerifiedEmails(cfg: GithubConfig, userToken: string): Promise<{ primary: string | null; all: string[] }> {
  const { status, json } = await userGet(cfg, userToken, `/user/emails?per_page=${PER_PAGE}`);
  if (!Array.isArray(json)) throw badShape(status);
  let primary: string | null = null;
  const all: string[] = [];
  for (const e of json as unknown[]) {
    if (!isObj(e) || e["verified"] !== true || typeof e["email"] !== "string") continue;
    const email = e["email"].trim().toLowerCase();
    if (!email) continue;
    if (!all.includes(email)) all.push(email);
    if (e["primary"] === true) primary = email;
  }
  return { primary, all };
}

/** Installazioni di questa App visibili all'utente (le altre App sono scartate). */
export async function listUserInstallations(
  cfg: GithubConfig,
  userToken: string,
): Promise<{ installationId: number; accountLogin: string; accountType: string; repositorySelection: string }[]> {
  const out: { installationId: number; accountLogin: string; accountType: string; repositorySelection: string }[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { status, json } = await userGet(cfg, userToken, `/user/installations?per_page=${PER_PAGE}&page=${page}`);
    if (!isObj(json) || !Array.isArray(json["installations"])) throw badShape(status);
    const list = json["installations"] as unknown[];
    for (const i of list) {
      if (!isObj(i) || typeof i["id"] !== "number" || String(i["app_id"]) !== cfg.appId) continue;
      const account = isObj(i["account"]) ? i["account"] : {};
      out.push({
        installationId: i["id"],
        accountLogin: typeof account["login"] === "string" ? account["login"] : "",
        accountType: typeof account["type"] === "string" ? account["type"] : "User",
        repositorySelection: typeof i["repository_selection"] === "string" ? i["repository_selection"] : "selected",
      });
    }
    if (list.length < PER_PAGE) break;
  }
  return out;
}

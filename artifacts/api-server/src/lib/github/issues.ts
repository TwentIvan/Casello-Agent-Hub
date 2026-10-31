import { isValidGithubRepo } from "../architect/sources";
import { GITHUB_MESSAGES, GithubError, githubCall, installationToken } from "./app";
import type { GithubConfig } from "./config";

/**
 * Client delle issue di GitHub per le voci del piano: token di installazione con `issues: write`
 * ristretto al repo, etichette, creazione ed elenco delle issue con l'etichetta `casello`.
 * Gli errori hanno testi fissi e un ambito: `batch` ferma tutto il lotto (permessi, repo, limiti),
 * `item` riguarda la sola voce (GitHub non raggiungibile, issue rifiutata).
 */

export const ISSUE_MESSAGES = {
  permission:
    "L'App Casello non ha il permesso Issues su questo repository (o non lo vede più): attivalo nelle impostazioni dell'installazione su GitHub",
  notFound: "Repository non trovato o non accessibile all'App Casello",
  disabled: "Le issue sono disattivate su questo repository",
  rateLimited: "GitHub ha limitato le richieste: riprova tra qualche minuto",
  unavailable: "GitHub non raggiungibile",
  rejected: "GitHub ha rifiutato l'issue",
} as const;

export class IssueError extends Error {
  readonly scope: "batch" | "item";
  constructor(message: string, scope: "batch" | "item") {
    super(message);
    this.name = "IssueError";
    this.scope = scope;
  }
}

const PER_PAGE = 100;
/** Tetto di pagine dell'elenco: al massimo 1000 issue per sincronizzazione. */
const MAX_PAGES = 10;
const LABEL_COLOR = "ededed";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function repoPath(repo: string): string {
  if (!isValidGithubRepo(repo)) throw new IssueError(ISSUE_MESSAGES.notFound, "batch");
  const [owner, name] = repo.split("/") as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/**
 * Chiamata con il token delle issue. Le eccezioni di `githubCall` sono 429/403 per limite di
 * richieste (→ rateLimited) o rete/5xx/risposte illeggibili (→ unavailable, sola voce).
 */
async function issuesCall(
  cfg: GithubConfig,
  input: { method: "GET" | "POST"; path: string; token: string; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  try {
    return await githubCall(cfg, { base: "api", ...input });
  } catch (e) {
    if (e instanceof GithubError) {
      if (e.status === 429 || e.status === 403) throw new IssueError(ISSUE_MESSAGES.rateLimited, "batch");
      throw new IssueError(ISSUE_MESSAGES.unavailable, "item");
    }
    throw e;
  }
}

/** Stati di errore comuni a etichette, creazione ed elenco. */
function statusError(status: number): IssueError {
  if (status === 401 || status === 403) return new IssueError(ISSUE_MESSAGES.permission, "batch");
  if (status === 404) return new IssueError(ISSUE_MESSAGES.notFound, "batch");
  if (status === 410) return new IssueError(ISSUE_MESSAGES.disabled, "batch");
  return new IssueError(ISSUE_MESSAGES.unavailable, "item");
}

/**
 * Token di installazione ristretto al repo con `issues: write`. GitHub non distingue, al momento del
 * token, permesso mancante e repo non più visibile (403/404/422): per entrambi il messaggio del permesso.
 */
export async function issuesToken(cfg: GithubConfig, installationId: number, repo: string): Promise<string> {
  try {
    return await installationToken(cfg, installationId, { repo, permissions: { issues: "write" } });
  } catch (e) {
    if (!(e instanceof GithubError)) throw e;
    if (e.message === GITHUB_MESSAGES.noAccess) throw new IssueError(ISSUE_MESSAGES.permission, "batch");
    if (e.status === 429 || e.status === 403) throw new IssueError(ISSUE_MESSAGES.rateLimited, "batch");
    throw new IssueError(ISSUE_MESSAGES.unavailable, "batch");
  }
}

/** Crea le etichette mancanti (grigie); 422 = già esistente, non è un errore. */
export async function ensureLabels(cfg: GithubConfig, token: string, repo: string, names: string[]): Promise<void> {
  const path = `${repoPath(repo)}/labels`;
  for (const name of new Set(names)) {
    const { status } = await issuesCall(cfg, { method: "POST", path, token, body: { name, color: LABEL_COLOR } });
    if (status !== 201 && status !== 422) throw statusError(status);
  }
}

export async function createIssue(
  cfg: GithubConfig,
  token: string,
  repo: string,
  input: { title: string; body: string; labels: string[] },
): Promise<{ number: number; url: string }> {
  const { status, json } = await issuesCall(cfg, { method: "POST", path: `${repoPath(repo)}/issues`, token, body: input });
  if (status === 422) throw new IssueError(ISSUE_MESSAGES.rejected, "item");
  if (status >= 300) throw statusError(status);
  if (!isObj(json) || typeof json["number"] !== "number" || typeof json["html_url"] !== "string") {
    throw new IssueError(ISSUE_MESSAGES.unavailable, "item");
  }
  return { number: json["number"], url: json["html_url"] };
}

/**
 * Issue con l'etichetta `casello` (aperte e chiuse, le pull request sono scartate), aggiornate da
 * `since` se indicato: numero → stato e motivo della chiusura. Al massimo 10 pagine da 100.
 */
export async function listCaselloIssues(
  cfg: GithubConfig,
  token: string,
  repo: string,
  since: Date | null,
): Promise<Map<number, { state: "open" | "closed"; stateReason: string | null }>> {
  const base = `${repoPath(repo)}/issues?state=all&labels=casello&per_page=${PER_PAGE}`;
  const sinceQuery = since ? `&since=${encodeURIComponent(since.toISOString())}` : "";
  const out = new Map<number, { state: "open" | "closed"; stateReason: string | null }>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { status, json } = await issuesCall(cfg, { method: "GET", path: `${base}&page=${page}${sinceQuery}`, token });
    if (status >= 300) throw statusError(status);
    if (!Array.isArray(json)) throw new IssueError(ISSUE_MESSAGES.unavailable, "item");
    for (const i of json as unknown[]) {
      if (!isObj(i) || typeof i["number"] !== "number" || "pull_request" in i) continue;
      if (i["state"] !== "open" && i["state"] !== "closed") continue;
      out.set(i["number"], { state: i["state"], stateReason: typeof i["state_reason"] === "string" ? i["state_reason"] : null });
    }
    if (json.length < PER_PAGE) break;
  }
  return out;
}

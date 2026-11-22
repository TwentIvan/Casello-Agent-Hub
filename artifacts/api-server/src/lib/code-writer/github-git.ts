import { GithubError, githubCall, installationToken } from "../github/app";
import type { GithubConfig } from "../github/config";
import { CODE_WRITE_MESSAGES, CodeWriteError } from "./messages";

/**
 * Client GitHub per il codice dei compiti delle squadre: ramo, commit (Git Data API), PR in bozza,
 * issue e CI. Ogni operazione chiede un token ristretto al repository e ai soli permessi che servono;
 * gli errori hanno testi fissi (`CODE_WRITE_MESSAGES`).
 */

export interface RepoRef {
  cfg: GithubConfig;
  installationId: number;
  repo: string;
}

export interface PullInfo {
  number: number;
  url: string;
  headSha: string;
}

export interface CiSnapshot {
  checks: { id: number; name: string; status: string; conclusion: string | null; jobId: number | null }[];
  statuses: { context: string; state: string }[];
}

const TASK_BRANCH_RE = /^botcave\/\d+-[A-Za-z0-9_-]{1,40}$/;
/** Branch di un lavoro su branch unico (`botcave/lavoro-<squadra>-<numero>`): l'unico che Botcave crea fuori dai compiti. */
export const WORK_BRANCH_RE = /^botcave\/lavoro-\d+-\d+$/;
const PER_PAGE = 100;
const MAX_PAGES = 5;
const LOG_TIMEOUT_MS = 15_000;
/** Del log si tengono solo gli ultimi byte: un log enorme (suite grandi) dà comunque la sua coda. */
const LOG_TAIL_BYTES = 256 * 1024;
const LOG_TAIL_LINES = 150;
const DEFAULT_LOG_SUFFIXES = [".actions.githubusercontent.com", ".blob.core.windows.net"];

let testLogHosts: string[] | null = null;
/** Solo per i test: sostituisce gli host ammessi per i log con host esatti (qualsiasi protocollo); null ripristina. */
export function setLogHostsForTests(hosts: string[] | null): void {
  testLogHosts = hosts;
}

function logHostAllowed(u: URL): boolean {
  if (testLogHosts) return testLogHosts.includes(u.host);
  return u.protocol === "https:" && DEFAULT_LOG_SUFFIXES.some((s) => u.hostname.endsWith(s));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function permissionsList(perms: Record<string, string>): string {
  return Object.entries(perms).map(([name, level]) => `${name}: ${level}`).join(", ");
}

async function tokenFor(r: RepoRef, permissions: Record<string, string>): Promise<string> {
  try {
    return await installationToken(r.cfg, r.installationId, { repo: r.repo, permissions });
  } catch (err) {
    if (err instanceof GithubError) {
      // 422: GitHub non concede il permesso chiesto (l'installazione non l'ha accettato)
      if (err.status === 422) throw new CodeWriteError(CODE_WRITE_MESSAGES.permission(permissionsList(permissions)), 422);
      if (err.message === CODE_WRITE_MESSAGES.noAccess) throw new CodeWriteError(CODE_WRITE_MESSAGES.noAccess, err.status);
      throw new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, err.status);
    }
    throw err;
  }
}

interface Call {
  method: "GET" | "POST" | "PATCH" | "PUT";
  path: string;
  body?: unknown;
}

/** Chiamata col token dato; 403 → permesso mancante, 401/404 → accesso perso; GitHub non raggiungibile → messaggio fisso. */
async function call(
  r: RepoRef,
  token: string,
  permission: string,
  c: Call,
  tolerate: number[] = [],
): Promise<{ status: number; json: unknown }> {
  let res: { status: number; json: unknown };
  try {
    res = await githubCall(r.cfg, { base: "api", token, ...c });
  } catch (err) {
    if (err instanceof GithubError) throw new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, err.status);
    throw err;
  }
  if (res.status < 400 || tolerate.includes(res.status)) return res;
  if (res.status === 403) throw new CodeWriteError(CODE_WRITE_MESSAGES.permission(permission), 403);
  if (res.status === 401 || res.status === 404) throw new CodeWriteError(CODE_WRITE_MESSAGES.noAccess, res.status);
  throw new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, res.status);
}

function repoPath(r: RepoRef, rest: string): string {
  const [owner, name] = r.repo.split("/") as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${rest}`;
}

function refPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function badShape(status: number | null = null): CodeWriteError {
  return new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, status);
}

function str(v: unknown, status: number): string {
  if (typeof v !== "string" || !v) throw badShape(status);
  return v;
}

function assertTaskBranch(branch: string): void {
  if (!TASK_BRANCH_RE.test(branch)) {
    throw new Error("scrittura rifiutata: il branch deve essere del tipo botcave/<squadra>-<compito>");
  }
}

// --- Lettura ----------------------------------------------------------------------------

const READ = { contents: "read" };

export async function getDefaultBranch(r: RepoRef): Promise<string> {
  const token = await tokenFor(r, READ);
  const { status, json } = await call(r, token, "contents: read", { method: "GET", path: repoPath(r, "") });
  if (!isObj(json)) throw badShape(status);
  return str(json["default_branch"], status);
}

export async function getBranchHead(r: RepoRef, branch: string): Promise<string | null> {
  const token = await tokenFor(r, READ);
  const { status, json } = await githubCallSafe(r, token, repoPath(r, `/git/ref/heads/${refPath(branch)}`));
  if (status === 404) return null;
  if (!isObj(json) || !isObj(json["object"])) throw badShape(status);
  return str(json["object"]["sha"], status);
}

/** GET che tollera il 404 (ramo o risorsa assente) ma non lo confonde con l'accesso perso del repo. */
async function githubCallSafe(r: RepoRef, token: string, path: string): Promise<{ status: number; json: unknown }> {
  return call(r, token, "contents: read", { method: "GET", path }, [404]);
}

/**
 * Crea il branch di un lavoro allo sha dato (`contents: write`, mai forzato). Un branch già esistente alla stessa testa va
 * bene (apertura ripetuta); a un'altra testa è un errore fisso. Solo nomi `botcave/lavoro-<squadra>-<numero>`.
 */
export async function createBranch(r: RepoRef, branch: string, sha: string): Promise<void> {
  if (!WORK_BRANCH_RE.test(branch)) throw new Error("scrittura rifiutata: il branch deve essere del tipo botcave/lavoro-<squadra>-<numero>");
  const token = await tokenFor(r, { contents: "write" });
  const { status } = await call(r, token, "contents: write", { method: "POST", path: repoPath(r, "/git/refs"), body: { ref: `refs/heads/${branch}`, sha } }, [422]);
  if (status !== 422) return;
  const head = await getBranchHead(r, branch);
  if (head !== sha) throw new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, 422);
}

/**
 * Sposta il branch di prova dell'App allo sha dato con `force: true` (lo crea se manca): l'unica scrittura forzata di
 * Botcave. Mai su `main`/`master` né su un branch di Botcave; il chiamante ricontrolla il nome con `checkStagingBranch`.
 */
export async function forceUpdateRef(r: RepoRef, branch: string, sha: string): Promise<void> {
  if (branch === "main" || branch === "master" || branch.startsWith("botcave/")) throw new Error("scrittura forzata rifiutata: branch non di prova");
  const token = await tokenFor(r, { contents: "write" });
  const { status } = await call(
    r,
    token,
    "contents: write",
    { method: "PATCH", path: repoPath(r, `/git/refs/heads/${refPath(branch)}`), body: { sha, force: true } },
    [404, 422],
  );
  if (status === 404 || status === 422) {
    const created = await call(r, token, "contents: write", { method: "POST", path: repoPath(r, "/git/refs"), body: { ref: `refs/heads/${branch}`, sha } }, [422]);
    if (created.status === 422) throw new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, 422);
  }
}

/** Confronto tra due commit: titoli dei commit (i più recenti) e file toccati, con tetti fissi. */
export interface CommitComparison {
  commits: string[];
  files: { filename: string; status: "added" | "modified" | "removed" | "renamed" }[];
  truncated: boolean;
}

/** Commit e file letti al più da un confronto (il resto si scarta e `truncated` lo segnala). */
export const COMPARE_MAX_COMMITS = 30;
export const COMPARE_MAX_FILES = 200;

/** Confronta `base...head`; null se uno dei due riferimenti non esiste (404 o 422 di GitHub). */
export async function compareCommits(r: RepoRef, base: string, head: string): Promise<CommitComparison | null> {
  const token = await tokenFor(r, READ);
  const { status, json } = await call(
    r,
    token,
    "contents: read",
    { method: "GET", path: repoPath(r, `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`) },
    [404, 422],
  );
  if (status === 404 || status === 422) return null;
  if (!isObj(json) || !Array.isArray(json["commits"]) || !Array.isArray(json["files"])) throw badShape(status);
  const allCommits: string[] = [];
  for (const c of json["commits"] as unknown[]) {
    if (!isObj(c) || !isObj(c["commit"]) || typeof c["commit"]["message"] !== "string") throw badShape(status);
    allCommits.push(c["commit"]["message"].split("\n")[0] ?? "");
  }
  const allFiles: CommitComparison["files"] = [];
  for (const f of json["files"] as unknown[]) {
    if (!isObj(f) || typeof f["filename"] !== "string" || typeof f["status"] !== "string") throw badShape(status);
    const s = f["status"];
    allFiles.push({ filename: f["filename"], status: s === "added" || s === "removed" || s === "renamed" ? s : "modified" });
  }
  // Con più di 250 commit GitHub ne taglia l'elenco: totale dichiarato oltre a quelli ricevuti = troncato.
  const total = typeof json["total_commits"] === "number" ? json["total_commits"] : allCommits.length;
  return {
    commits: allCommits.slice(-COMPARE_MAX_COMMITS),
    files: allFiles.slice(0, COMPARE_MAX_FILES),
    truncated: allCommits.length > COMPARE_MAX_COMMITS || total > allCommits.length || allFiles.length > COMPARE_MAX_FILES,
  };
}

export async function getCommitTree(r: RepoRef, sha: string): Promise<string> {
  const token = await tokenFor(r, READ);
  const { status, json } = await call(r, token, "contents: read", { method: "GET", path: repoPath(r, `/git/commits/${encodeURIComponent(sha)}`) });
  if (!isObj(json) || !isObj(json["tree"])) throw badShape(status);
  return str(json["tree"]["sha"], status);
}

/**
 * Modi dei file modificati già presenti nell'albero di partenza: 100755 si conserva; link simbolici (120000)
 * e sottomoduli (160000) fanno rifiutare il commit prima di scrivere qualsiasi blob. Albero troncato:
 * i percorsi non trovati restano 100644.
 */
async function existingModes(r: RepoRef, token: string, baseTreeSha: string, paths: Iterable<string>): Promise<Map<string, string>> {
  const wanted = new Set(paths);
  const out = new Map<string, string>();
  const { status, json } = await call(r, token, "contents: write", { method: "GET", path: repoPath(r, `/git/trees/${encodeURIComponent(baseTreeSha)}?recursive=1`) });
  if (!isObj(json) || !Array.isArray(json["tree"])) throw badShape(status);
  for (const e of json["tree"] as unknown[]) {
    if (!isObj(e) || typeof e["path"] !== "string" || typeof e["mode"] !== "string" || !wanted.has(e["path"])) continue;
    if (e["mode"] === "120000" || e["mode"] === "160000" || e["type"] === "commit") throw new CodeWriteError(CODE_WRITE_MESSAGES.specialFile(e["path"]));
    out.set(e["path"], e["mode"]);
  }
  return out;
}

// --- Commit -----------------------------------------------------------------------------

export async function commitFiles(
  r: RepoRef,
  input: {
    branch: string;
    parentSha: string;
    baseTreeSha: string;
    changes: Map<string, string | null>;
    message: string;
    createBranch: boolean;
  },
): Promise<{ sha: string }> {
  assertTaskBranch(input.branch);
  return writeCommit(r, input);
}

/**
 * Commit di inizializzazione di una nuova App sul branch `main` del repository appena creato dal modello
 * (`PATCH` della ref con `force: false`: se `main` è avanzato, `CodeWriteError` con `branchMoved`). Solo per
 * `app-bootstrap`: i compiti delle squadre passano da `commitFiles`, che resta limitato ai branch `botcave/…`.
 */
export async function commitInitOnBase(
  r: RepoRef,
  input: { parentSha: string; baseTreeSha: string; changes: Map<string, string | null>; message: string },
): Promise<{ sha: string }> {
  return writeCommit(r, { ...input, branch: "main", createBranch: false });
}

async function writeCommit(
  r: RepoRef,
  input: {
    branch: string;
    parentSha: string;
    baseTreeSha: string;
    changes: Map<string, string | null>;
    message: string;
    createBranch: boolean;
  },
): Promise<{ sha: string }> {
  const perm = "contents: write";
  const token = await tokenFor(r, { contents: "write" });
  const modes = await existingModes(r, token, input.baseTreeSha, input.changes.keys());
  const tree: { path: string; mode: string; type: string; sha: string | null }[] = [];
  for (const [path, content] of input.changes) {
    if (content === null) {
      tree.push({ path, mode: modes.get(path) ?? "100644", type: "blob", sha: null });
      continue;
    }
    const { status, json } = await call(r, token, perm, {
      method: "POST",
      path: repoPath(r, "/git/blobs"),
      body: { content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" },
    });
    if (!isObj(json)) throw badShape(status);
    tree.push({ path, mode: modes.get(path) ?? "100644", type: "blob", sha: str(json["sha"], status) });
  }
  const t = await call(r, token, perm, {
    method: "POST",
    path: repoPath(r, "/git/trees"),
    body: { base_tree: input.baseTreeSha, tree },
  });
  if (!isObj(t.json)) throw badShape(t.status);
  const treeSha = str(t.json["sha"], t.status);
  const c = await call(r, token, perm, {
    method: "POST",
    path: repoPath(r, "/git/commits"),
    body: { message: input.message, tree: treeSha, parents: [input.parentSha] },
  });
  if (!isObj(c.json)) throw badShape(c.status);
  const sha = str(c.json["sha"], c.status);
  if (input.createBranch) {
    const res = await call(r, token, perm, { method: "POST", path: repoPath(r, "/git/refs"), body: { ref: `refs/heads/${input.branch}`, sha } }, [422]);
    if (res.status === 422) throw new CodeWriteError(CODE_WRITE_MESSAGES.branchMoved, 422);
  } else {
    const res = await call(
      r,
      token,
      perm,
      { method: "PATCH", path: repoPath(r, `/git/refs/heads/${refPath(input.branch)}`), body: { sha, force: false } },
      [422],
    );
    if (res.status === 422) throw new CodeWriteError(CODE_WRITE_MESSAGES.branchMoved, 422);
  }
  return { sha };
}

// --- PR ---------------------------------------------------------------------------------

const PULLS = { pull_requests: "write" };

function pullInfo(json: unknown, status: number): PullInfo {
  if (!isObj(json) || typeof json["number"] !== "number" || !isObj(json["head"])) throw badShape(status);
  return { number: json["number"], url: str(json["html_url"], status), headSha: str(json["head"]["sha"], status) };
}

export async function findOpenPull(r: RepoRef, branch: string): Promise<PullInfo | null> {
  const token = await tokenFor(r, PULLS);
  const owner = r.repo.split("/")[0]!;
  const { status, json } = await call(r, token, "pull_requests: write", {
    method: "GET",
    path: repoPath(r, `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=${PER_PAGE}`),
  });
  if (!Array.isArray(json)) throw badShape(status);
  for (const p of json as unknown[]) {
    if (isObj(p) && isObj(p["head"]) && p["head"]["ref"] === branch) return pullInfo(p, status);
  }
  return null;
}

export async function createDraftPull(r: RepoRef, input: { head: string; base: string; title: string; body: string }): Promise<PullInfo> {
  assertTaskBranch(input.head);
  if (input.head === input.base) throw new Error("scrittura rifiutata: il branch del compito coincide con il base");
  const token = await tokenFor(r, PULLS);
  const { status, json } = await call(
    r,
    token,
    "pull_requests: write",
    { method: "POST", path: repoPath(r, "/pulls"), body: { title: input.title, body: input.body, head: input.head, base: input.base, draft: true } },
    [422],
  );
  if (status === 422) throw new CodeWriteError(CODE_WRITE_MESSAGES.pullRejected, 422);
  return pullInfo(json, status);
}

export async function getPull(r: RepoRef, n: number): Promise<{ state: "open" | "merged" | "closed"; headSha: string; url: string }> {
  const token = await tokenFor(r, PULLS);
  const { status, json } = await call(r, token, "pull_requests: write", { method: "GET", path: repoPath(r, `/pulls/${n}`) }, [404]);
  if (status === 404) throw new CodeWriteError(CODE_WRITE_MESSAGES.pullNotFound(n), 404);
  const info = pullInfo(json, status);
  const o = json as Record<string, unknown>;
  const state = o["merged"] === true || typeof o["merged_at"] === "string" ? "merged" : o["state"] === "open" ? "open" : "closed";
  return { state, headSha: info.headSha, url: info.url };
}

// --- Merge ------------------------------------------------------------------------------

export interface PullDetail {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  nodeId: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  title: string;
}

/** PR con i dati che servono al merge: bozza, `node_id` (GraphQL), branch di testa e di base. */
export async function getPullDetail(r: RepoRef, n: number): Promise<PullDetail> {
  const token = await tokenFor(r, PULLS);
  const { status, json } = await call(r, token, "pull_requests: write", { method: "GET", path: repoPath(r, `/pulls/${n}`) }, [404]);
  if (status === 404) throw new CodeWriteError(CODE_WRITE_MESSAGES.pullNotFound(n), 404);
  const info = pullInfo(json, status);
  const o = json as Record<string, unknown>;
  const head = o["head"] as Record<string, unknown>;
  const base = isObj(o["base"]) ? o["base"] : {};
  const state = o["merged"] === true || typeof o["merged_at"] === "string" ? "merged" : o["state"] === "open" ? "open" : "closed";
  return {
    number: info.number,
    url: info.url,
    state,
    draft: o["draft"] === true,
    nodeId: str(o["node_id"], status),
    headRef: str(head["ref"], status),
    baseRef: str(base["ref"], status),
    headSha: info.headSha,
    title: typeof o["title"] === "string" ? o["title"] : "",
  };
}

/** Pagine di file di una PR lette al più (100 file l'una): oltre, la PR è troppo grande per un merge automatico. */
export const MAX_PULL_FILE_PAGES = 10;

/** File di una PR: percorso, stato assegnato da GitHub (`added`, `modified`, `removed`, `renamed`…) e nome precedente se rinominato. */
export type PullFile = { filename: string; status: string; previousFilename: string | null };

/** File toccati da una PR con il loro stato; null se i file sono troppi da leggere. */
export async function listPullFiles(r: RepoRef, n: number): Promise<PullFile[] | null> {
  const token = await tokenFor(r, PULLS);
  const out: PullFile[] = [];
  for (let page = 1; page <= MAX_PULL_FILE_PAGES; page++) {
    const { status, json } = await call(r, token, "pull_requests: write", {
      method: "GET",
      path: repoPath(r, `/pulls/${n}/files?per_page=${PER_PAGE}&page=${page}`),
    });
    if (!Array.isArray(json)) throw badShape(status);
    for (const f of json as unknown[]) {
      if (!isObj(f) || typeof f["filename"] !== "string" || typeof f["status"] !== "string") throw badShape(status);
      out.push({
        filename: f["filename"],
        status: f["status"],
        previousFilename: typeof f["previous_filename"] === "string" ? f["previous_filename"] : null,
      });
    }
    if (json.length < PER_PAGE) return out;
  }
  return null;
}

/** Dimensione massima di un file letto con `readFileAt`: oltre, la contents API non dà il contenuto. */
export const MAX_READ_FILE_BYTES = 1024 * 1024;

/** Contenuto UTF-8 di un file a un ref (branch, tag o sha); null se il file non esiste a quel ref. */
export async function readFileAt(r: RepoRef, path: string, ref: string): Promise<string | null> {
  const token = await tokenFor(r, READ);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const { status, json } = await call(
    r,
    token,
    "contents: read",
    { method: "GET", path: repoPath(r, `/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`) },
    [404],
  );
  if (status === 404) return null;
  if (!isObj(json) || json["type"] !== "file" || json["encoding"] !== "base64" || typeof json["content"] !== "string") throw badShape(status);
  if (typeof json["size"] === "number" && json["size"] > MAX_READ_FILE_BYTES) throw badShape(status);
  return Buffer.from(json["content"], "base64").toString("utf8");
}

const MERGE = { contents: "write", pull_requests: "write" };

/** Toglie la PR dalla bozza (GraphQL `markPullRequestReadyForReview`): la REST non lo permette. */
export async function markReadyForReview(r: RepoRef, nodeId: string): Promise<void> {
  const token = await tokenFor(r, MERGE);
  const { status, json } = await call(r, token, "pull_requests: write", {
    method: "POST",
    path: "/graphql",
    body: {
      query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
      variables: { id: nodeId },
    },
  });
  if (!isObj(json)) throw badShape(status);
  const data = isObj(json["data"]) ? json["data"] : null;
  const mutation = data && isObj(data["markPullRequestReadyForReview"]) ? data["markPullRequestReadyForReview"] : null;
  const pr = mutation && isObj(mutation["pullRequest"]) ? mutation["pullRequest"] : null;
  if (Array.isArray(json["errors"]) && json["errors"].length > 0) {
    const forbidden = (json["errors"] as unknown[]).some((e) => isObj(e) && e["type"] === "FORBIDDEN");
    if (forbidden) throw new CodeWriteError(CODE_WRITE_MESSAGES.permission("pull_requests: write"), 403);
    throw new CodeWriteError(CODE_WRITE_MESSAGES.notReady, status);
  }
  if (!pr || pr["isDraft"] !== false) throw new CodeWriteError(CODE_WRITE_MESSAGES.notReady, status);
}

/**
 * Unisce la PR con squash, solo se la testa è ancora `sha` (GitHub risponde 409 altrimenti). 405: non unibile (conflitti,
 * regole del branch base, bozza); 409: testa cambiata; 422: rifiutata.
 */
export async function squashMerge(r: RepoRef, n: number, input: { sha: string; title: string }): Promise<{ sha: string }> {
  const token = await tokenFor(r, MERGE);
  const { status, json } = await call(
    r,
    token,
    "contents: write, pull_requests: write",
    { method: "PUT", path: repoPath(r, `/pulls/${n}/merge`), body: { merge_method: "squash", sha: input.sha, commit_title: input.title } },
    [405, 409, 422],
  );
  if (status === 409) throw new CodeWriteError(CODE_WRITE_MESSAGES.headMoved, 409);
  if (status === 405 || status === 422) throw new CodeWriteError(CODE_WRITE_MESSAGES.notMergeable, status);
  if (!isObj(json) || json["merged"] !== true) throw new CodeWriteError(CODE_WRITE_MESSAGES.notMergeable, status);
  return { sha: str(json["sha"], status) };
}

// --- Rilascio di un lavoro su branch unico --------------------------------------------------

/**
 * Unisce `head` (il base dell'App) nel branch di un lavoro (`POST /merges`): `up_to_date` se lo contiene già, `conflict` con
 * un 409, altrimenti `merged` con lo sha del commit di merge. Solo verso branch `botcave/lavoro-…`.
 */
export async function mergeBranches(r: RepoRef, input: { base: string; head: string; message: string }): Promise<{ result: "merged"; sha: string } | { result: "up_to_date" | "conflict" }> {
  if (!WORK_BRANCH_RE.test(input.base)) throw new Error("scrittura rifiutata: si unisce solo nel branch di un lavoro");
  const token = await tokenFor(r, { contents: "write" });
  const { status, json } = await call(
    r,
    token,
    "contents: write",
    { method: "POST", path: repoPath(r, "/merges"), body: { base: input.base, head: input.head, commit_message: input.message } },
    [204, 409],
  );
  if (status === 204) return { result: "up_to_date" };
  if (status === 409) return { result: "conflict" };
  if (!isObj(json)) throw badShape(status);
  return { result: "merged", sha: str(json["sha"], status) };
}

/** PR del lavoro verso il base (non in bozza): riusa quella aperta sullo stesso branch, altrimenti la apre. */
export async function openReleasePull(r: RepoRef, input: { head: string; base: string; title: string; body: string }): Promise<PullInfo> {
  if (!WORK_BRANCH_RE.test(input.head)) throw new Error("scrittura rifiutata: la PR di rilascio parte solo da un lavoro");
  const existing = await findOpenPull(r, input.head);
  if (existing) return existing;
  const token = await tokenFor(r, PULLS);
  const { status, json } = await call(
    r,
    token,
    "pull_requests: write",
    { method: "POST", path: repoPath(r, "/pulls"), body: { title: input.title, body: input.body, head: input.head, base: input.base, draft: false } },
    [422],
  );
  if (status === 422) throw new CodeWriteError(CODE_WRITE_MESSAGES.pullRejected, 422);
  return pullInfo(json, status);
}

/** Unisce la PR di rilascio con un commit di merge (conserva i commit dei compiti e i loro «Closes #n») sulla testa controllata. */
export async function mergeCommit(r: RepoRef, n: number, input: { sha: string; title: string }): Promise<{ sha: string }> {
  const token = await tokenFor(r, MERGE);
  const { status, json } = await call(
    r,
    token,
    "contents: write, pull_requests: write",
    { method: "PUT", path: repoPath(r, `/pulls/${n}/merge`), body: { merge_method: "merge", sha: input.sha, commit_title: input.title } },
    [405, 409, 422],
  );
  if (status === 409) throw new CodeWriteError(CODE_WRITE_MESSAGES.headMoved, 409);
  if (status === 405 || status === 422) throw new CodeWriteError(CODE_WRITE_MESSAGES.notMergeable, status);
  if (!isObj(json) || json["merged"] !== true) throw new CodeWriteError(CODE_WRITE_MESSAGES.notMergeable, status);
  return { sha: str(json["sha"], status) };
}

// --- Issue ------------------------------------------------------------------------------

export async function getIssue(r: RepoRef, n: number): Promise<{ title: string; state: string; labels: string[]; body: string }> {
  const token = await tokenFor(r, { issues: "read" });
  const { status, json } = await call(r, token, "issues: read", { method: "GET", path: repoPath(r, `/issues/${n}`) }, [404]);
  if (status === 404) throw new CodeWriteError(CODE_WRITE_MESSAGES.issueNotFound(n), 404);
  if (!isObj(json) || typeof json["title"] !== "string") throw badShape(status);
  const labels = Array.isArray(json["labels"])
    ? (json["labels"] as unknown[]).flatMap((l) => (isObj(l) && typeof l["name"] === "string" ? [l["name"]] : typeof l === "string" ? [l] : []))
    : [];
  return {
    title: json["title"],
    state: typeof json["state"] === "string" ? json["state"] : "open",
    labels,
    body: typeof json["body"] === "string" ? json["body"] : "",
  };
}

// --- CI ---------------------------------------------------------------------------------

const CI = { checks: "read", statuses: "read", actions: "read" };

export async function readCi(r: RepoRef, sha: string): Promise<CiSnapshot> {
  const token = await tokenFor(r, CI);
  const checks: CiSnapshot["checks"] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { status, json } = await call(r, token, "checks: read", {
      method: "GET",
      path: repoPath(r, `/commits/${encodeURIComponent(sha)}/check-runs?per_page=${PER_PAGE}&page=${page}`),
    });
    if (!isObj(json) || !Array.isArray(json["check_runs"])) throw badShape(status);
    const runs = json["check_runs"] as unknown[];
    for (const c of runs) {
      if (!isObj(c) || typeof c["id"] !== "number" || typeof c["name"] !== "string") continue;
      const m = typeof c["details_url"] === "string" ? /\/job\/(\d+)(?:$|[/?#])/.exec(c["details_url"]) : null;
      checks.push({
        id: c["id"],
        name: c["name"],
        status: typeof c["status"] === "string" ? c["status"] : "unknown",
        conclusion: typeof c["conclusion"] === "string" ? c["conclusion"] : null,
        jobId: m ? Number(m[1]) : null,
      });
    }
    if (runs.length < PER_PAGE) break;
  }
  const s = await call(r, token, "statuses: read", { method: "GET", path: repoPath(r, `/commits/${encodeURIComponent(sha)}/status`) });
  if (!isObj(s.json) || !Array.isArray(s.json["statuses"])) throw badShape(s.status);
  const statuses = (s.json["statuses"] as unknown[]).flatMap((x) =>
    isObj(x) && typeof x["context"] === "string" && typeof x["state"] === "string" ? [{ context: x["context"], state: x["state"] }] : [],
  );
  return { checks, statuses };
}

/** Annotazioni di un check run (percorso, riga, messaggio), al più `max` (≤ 100): una sola pagina. */
export async function checkRunAnnotations(r: RepoRef, checkRunId: number, max: number): Promise<{ path: string; line: number | null; message: string }[]> {
  const perPage = Math.min(Math.max(Math.trunc(max), 1), PER_PAGE);
  const token = await tokenFor(r, CI);
  const { status, json } = await call(r, token, "checks: read", {
    method: "GET",
    path: repoPath(r, `/check-runs/${checkRunId}/annotations?per_page=${perPage}&page=1`),
  });
  if (!Array.isArray(json)) throw badShape(status);
  return (json as unknown[])
    .flatMap((a) =>
      isObj(a) && typeof a["path"] === "string" && typeof a["message"] === "string"
        ? [{ path: a["path"], line: typeof a["start_line"] === "number" ? a["start_line"] : null, message: a["message"] }]
        : [],
    )
    .slice(0, perPage);
}

/** Coda del log di un job (ultime 150 righe): segue un solo redirect, verso un host ammesso e senza Authorization. */
export async function failedJobLogTail(r: RepoRef, jobId: number): Promise<string> {
  const token = await tokenFor(r, CI);
  const url = `${r.cfg.apiBase}${repoPath(r, `/actions/jobs/${jobId}/logs`)}`;
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "casello" };
  let res: Response;
  try {
    res = await fetch(url, { headers: { ...headers, authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(LOG_TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      let target: URL;
      try {
        target = new URL(loc ?? "");
      } catch {
        throw new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, res.status);
      }
      if (!logHostAllowed(target)) throw new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, res.status);
      res = await fetch(target, { headers: { "user-agent": "casello" }, redirect: "manual", signal: AbortSignal.timeout(LOG_TIMEOUT_MS) });
    }
  } catch (err) {
    if (err instanceof CodeWriteError) throw err;
    throw new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, null);
  }
  if (res.status === 403) {
    await res.body?.cancel().catch(() => {});
    throw new CodeWriteError(CODE_WRITE_MESSAGES.permission("actions: read"), 403);
  }
  if (res.status === 401 || res.status === 404) {
    await res.body?.cancel().catch(() => {});
    throw new CodeWriteError(CODE_WRITE_MESSAGES.noAccess, res.status);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, res.status);
  }
  let tail: { bytes: Uint8Array; truncated: boolean };
  try {
    tail = await readTailBytes(res, LOG_TAIL_BYTES);
  } catch {
    throw new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, res.status);
  }
  const lines = new TextDecoder("utf-8").decode(tail.bytes).replace(/\r\n/g, "\n").split("\n");
  // La prima riga di una coda tagliata è a metà: si scarta
  if (tail.truncated) lines.shift();
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-LOG_TAIL_LINES).join("\n");
}

/**
 * Legge tutto il corpo tenendo in memoria solo gli ultimi `maxBytes` (il tempo lo limita il segnale della fetch).
 */
async function readTailBytes(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  let chunks: Uint8Array[] = [];
  let kept = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    kept += value.byteLength;
    if (kept > 2 * maxBytes) {
      const all = Buffer.concat(chunks);
      chunks = [all.subarray(all.byteLength - maxBytes)];
      kept = maxBytes;
      truncated = true;
    }
  }
  const all = Buffer.concat(chunks);
  if (all.byteLength > maxBytes) {
    truncated = true;
    return { bytes: new Uint8Array(all.subarray(all.byteLength - maxBytes)), truncated };
  }
  return { bytes: new Uint8Array(all), truncated };
}

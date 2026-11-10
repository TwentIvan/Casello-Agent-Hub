import { GithubError, githubCall, installationToken } from "../github/app";
import type { GithubConfig } from "../github/config";
import { readBytesLimited } from "../http-read";
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

const BRANCH_PREFIX = "botcave/";
const PER_PAGE = 100;
const MAX_PAGES = 5;
const LOG_TIMEOUT_MS = 15_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
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
  const entries = Object.entries(perms);
  const [name, level] = entries[0]!;
  return `${name}: ${level}`;
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
  method: "GET" | "POST" | "PATCH";
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
  if (!branch.startsWith(BRANCH_PREFIX) || branch.length === BRANCH_PREFIX.length) {
    throw new Error("scrittura rifiutata: il branch deve iniziare con botcave/");
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

export async function getCommitTree(r: RepoRef, sha: string): Promise<string> {
  const token = await tokenFor(r, READ);
  const { status, json } = await call(r, token, "contents: read", { method: "GET", path: repoPath(r, `/git/commits/${encodeURIComponent(sha)}`) });
  if (!isObj(json) || !isObj(json["tree"])) throw badShape(status);
  return str(json["tree"]["sha"], status);
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
  const perm = "contents: write";
  const token = await tokenFor(r, { contents: "write" });
  const tree: { path: string; mode: string; type: string; sha: string | null }[] = [];
  for (const [path, content] of input.changes) {
    if (content === null) {
      tree.push({ path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const { status, json } = await call(r, token, perm, {
      method: "POST",
      path: repoPath(r, "/git/blobs"),
      body: { content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" },
    });
    if (!isObj(json)) throw badShape(status);
    tree.push({ path, mode: "100644", type: "blob", sha: str(json["sha"], status) });
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
  const token = await tokenFor(r, PULLS);
  const { status, json } = await call(r, token, "pull_requests: write", {
    method: "POST",
    path: repoPath(r, "/pulls"),
    body: { title: input.title, body: input.body, head: input.head, base: input.base, draft: true },
  });
  return pullInfo(json, status);
}

export async function getPull(r: RepoRef, n: number): Promise<{ state: "open" | "merged" | "closed"; headSha: string; url: string }> {
  const token = await tokenFor(r, PULLS);
  const { status, json } = await call(r, token, "pull_requests: write", { method: "GET", path: repoPath(r, `/pulls/${n}`) });
  const info = pullInfo(json, status);
  const o = json as Record<string, unknown>;
  const state = o["merged"] === true || typeof o["merged_at"] === "string" ? "merged" : o["state"] === "open" ? "open" : "closed";
  return { state, headSha: info.headSha, url: info.url };
}

// --- Issue ------------------------------------------------------------------------------

export async function getIssue(r: RepoRef, n: number): Promise<{ title: string; state: string; labels: string[]; body: string }> {
  const token = await tokenFor(r, { issues: "read" });
  const { status, json } = await call(r, token, "issues: read", { method: "GET", path: repoPath(r, `/issues/${n}`) });
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
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, res.status);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8").decode(await readBytesLimited(res, LOG_MAX_BYTES));
  } catch {
    throw new CodeWriteError(CODE_WRITE_MESSAGES.unavailable, res.status);
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-LOG_TAIL_LINES).join("\n");
}

import { SourceError, fetchGithubTree } from "../architect/sources";
import { GITHUB_MESSAGES, GithubError, githubCall, installationToken } from "../github/app";
import { githubConfig } from "../github/config";
import { CODE_WRITE_MESSAGES, CodeWriteError } from "../code-writer/messages";
import { findCredential } from "../code-writer/secrets-check";
import { commitInitOnBase } from "../code-writer/github-git";
import { appTemplateRepo } from "./config";
import { MAX_FILES, type TemplateEntry } from "./personalize";
import { APP_BOOTSTRAP_MESSAGES as M } from "./messages";

/**
 * GitHub per la creazione di una nuova App da zero: ispezione del repository creato dal modello e commit di
 * inizializzazione su `main`. Messaggi fissi (`APP_BOOTSTRAP_MESSAGES`), mai testo di GitHub, token o contenuti.
 */

const MARKER_PATH = ".botcave/modello.json";
const MARKER_TEMPLATE = "botcave-modello-app";
const BASE_BRANCH = "main";

export type RepoInspection =
  | { kind: "fresh"; headSha: string; treeSha: string; files: Map<string, string>; entries: Map<string, TemplateEntry> }
  | { kind: "initialized"; headSha: string }
  | { kind: "error"; message: string };

const err = (message: string): RepoInspection => ({ kind: "error", message });

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function repoPath(repo: string, rest: string): string {
  const [owner, name] = repo.split("/") as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${rest}`;
}

/** Marcatore del modello: oggetto con `template` giusto, altrimenti null. */
function parseMarker(text: string | undefined): { slug: string | null } | null {
  if (text === undefined) return null;
  try {
    const v: unknown = JSON.parse(text);
    if (!isObj(v) || v["template"] !== MARKER_TEMPLATE) return null;
    return { slug: typeof v["slug"] === "string" ? v["slug"] : null };
  } catch {
    return null;
  }
}

export async function inspectRepo(input: { repo: string; installationId: number; slug: string }): Promise<RepoInspection> {
  const cfg = githubConfig();
  if (!cfg) return err(M.githubUnavailable);
  let token: string;
  try {
    token = await installationToken(cfg, input.installationId, { repo: input.repo, permissions: { contents: "read" } });
  } catch (e) {
    if (e instanceof GithubError && e.message === GITHUB_MESSAGES.noAccess) return err(M.notVisible);
    return err(M.githubUnavailable);
  }
  const get = (rest: string) => githubCall(cfg, { base: "api", method: "GET", path: repoPath(input.repo, rest), token });
  try {
    const repo = await get("");
    if (repo.status === 401 || repo.status === 403 || repo.status === 404) return err(M.notVisible);
    if (!isObj(repo.json)) return err(M.githubUnavailable);
    const tpl = repo.json["template_repository"];
    if (isObj(tpl) && typeof tpl["full_name"] === "string" && tpl["full_name"].toLowerCase() !== appTemplateRepo().toLowerCase()) {
      return err(M.notFromTemplate);
    }

    const list = await get(`/commits?sha=${BASE_BRANCH}&per_page=3`);
    if (list.status === 401 || list.status === 403 || list.status === 404) return err(M.notVisible);
    if (!Array.isArray(list.json) || list.json.length === 0) return err(M.githubUnavailable);
    const first: unknown = list.json[0];
    if (!isObj(first) || typeof first["sha"] !== "string" || !isObj(first["commit"]) || !isObj(first["commit"]["tree"]) || typeof first["commit"]["tree"]["sha"] !== "string") {
      return err(M.githubUnavailable);
    }
    const headSha = first["sha"];
    const treeSha = first["commit"]["tree"]["sha"];

    // Lo zipball è dello sha letto, non del branch: nessuna corsa con un push intermedio
    const tree = await fetchGithubTree({ repo: input.repo, branch: headSha, token, apiBase: cfg.apiBase });
    const marker = parseMarker(tree.text(MARKER_PATH));
    if (!marker) return err(M.notFromTemplate);

    if (list.json.length === 1) {
      // Albero completo: le voci che lo zipball non dà come testo (binari, cartelle ignorate, file grandi) si spostano col loro blob
      const t = await get(`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
      if (t.status === 401 || t.status === 403 || t.status === 404) return err(M.notVisible);
      if (!isObj(t.json) || !Array.isArray(t.json["tree"])) return err(M.githubUnavailable);
      if (t.json["truncated"] === true) return err(M.treeTruncated);
      const entries = new Map<string, TemplateEntry>();
      for (const e of t.json["tree"] as unknown[]) {
        if (!isObj(e) || typeof e["path"] !== "string" || typeof e["mode"] !== "string" || typeof e["sha"] !== "string") continue;
        if (e["type"] !== "blob" && e["type"] !== "commit") continue;
        entries.set(e["path"], { mode: e["mode"], sha: e["sha"] });
      }
      return { kind: "fresh", headSha, treeSha, files: tree.allFiles(), entries };
    }
    if (list.json.length === 2 && marker.slug === input.slug) return { kind: "initialized", headSha };
    return err(M.notFresh);
  } catch (e) {
    if (e instanceof SourceError && (e.status === 401 || e.status === 403 || e.status === 404)) return err(M.notVisible);
    return err(M.githubUnavailable);
  }
}

/**
 * Limiti del commit di inizializzazione: ogni file del modello rinominato vale due voci (nuovo ed eliminato), più
 * AGENT_BRIEF.md e il marcatore. Lo stesso `MAX_FILES` della personalizzazione: i due limiti sono uno solo.
 */
export const INIT_LIMITS = { maxEntries: 2 * MAX_FILES + 2, maxFileBytes: 1_048_576, maxTotalBytes: 5_242_880 } as const;

export type ReusedEntry = { path: string; mode: string; sha: string };

/** Percorsi che Botcave non scrive mai: `.git/`, `.github/`, `.env` e `.env.*` (anche in sottocartelle). */
function pathRefused(path: string): boolean {
  if (path.startsWith(".git/") || path.startsWith(".github/")) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base === ".env" || base.startsWith(".env.");
}

/** null = commit di inizializzazione ammissibile, altrimenti il messaggio fisso. */
export function checkInitChanges(changes: Map<string, string | null>, reuse: ReusedEntry[] = []): string | null {
  if (changes.size === 0 && reuse.length === 0) return CODE_WRITE_MESSAGES.nothingToCommit;
  if (changes.size + reuse.length > INIT_LIMITS.maxEntries) return M.tooManyFiles;
  for (const e of reuse) if (pathRefused(e.path)) return M.pathRefused;
  let total = 0;
  for (const [path, content] of changes) {
    if (pathRefused(path)) return M.pathRefused;
    if (content === null) continue;
    if (content.includes("\0")) return M.tooManyFiles;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > INIT_LIMITS.maxFileBytes) return M.tooManyFiles;
    total += bytes;
    if (total > INIT_LIMITS.maxTotalBytes) return M.tooManyFiles;
    if (findCredential(content)) return CODE_WRITE_MESSAGES.credential(path);
  }
  return null;
}

export async function initializeRepo(input: {
  repo: string;
  installationId: number;
  parentSha: string;
  baseTreeSha: string;
  changes: Map<string, string | null>;
  message: string;
  modes?: Map<string, string>;
  reuse?: ReusedEntry[];
}): Promise<{ sha: string } | { error: string }> {
  const cfg = githubConfig();
  if (!cfg) return { error: M.githubUnavailable };
  const problem = checkInitChanges(input.changes, input.reuse);
  if (problem) return { error: problem };
  try {
    return await commitInitOnBase(
      { cfg, installationId: input.installationId, repo: input.repo },
      {
        parentSha: input.parentSha,
        baseTreeSha: input.baseTreeSha,
        changes: input.changes,
        message: input.message,
        modes: input.modes,
        reuse: input.reuse,
      },
    );
  } catch (e) {
    if (e instanceof CodeWriteError) {
      if (e.message === CODE_WRITE_MESSAGES.branchMoved) return { error: M.notFresh };
      if (e.message === CODE_WRITE_MESSAGES.noAccess) return { error: M.notVisible };
      if (e.message === CODE_WRITE_MESSAGES.unavailable) return { error: M.githubUnavailable };
      return { error: e.message };
    }
    return { error: M.githubUnavailable };
  }
}

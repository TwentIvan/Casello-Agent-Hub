import { SourceError, fetchGithubTree } from "../architect/sources";
import { GITHUB_MESSAGES, GithubError, githubCall, installationToken } from "../github/app";
import { githubConfig } from "../github/config";
import { CODE_WRITE_MESSAGES, CodeWriteError } from "../code-writer/messages";
import { checkCommit } from "../code-writer/secrets-check";
import { commitInitOnBase } from "../code-writer/github-git";
import { appTemplateRepo } from "./config";
import { APP_BOOTSTRAP_MESSAGES as M } from "./messages";

/**
 * GitHub per la creazione di una nuova App da zero: ispezione del repository creato dal modello e commit di
 * inizializzazione su `main`. Messaggi fissi (`APP_BOOTSTRAP_MESSAGES`), mai testo di GitHub, token o contenuti.
 */

const MARKER_PATH = ".botcave/modello.json";
const MARKER_TEMPLATE = "botcave-modello-app";
const BASE_BRANCH = "main";

export type RepoInspection =
  | { kind: "fresh"; headSha: string; treeSha: string; files: Map<string, string> }
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

    if (list.json.length === 1) return { kind: "fresh", headSha, treeSha, files: tree.allFiles() };
    if (list.json.length === 2 && marker.slug === input.slug) return { kind: "initialized", headSha };
    return err(M.notFresh);
  } catch (e) {
    if (e instanceof SourceError && (e.status === 401 || e.status === 403 || e.status === 404)) return err(M.notVisible);
    return err(M.githubUnavailable);
  }
}

export async function initializeRepo(input: {
  repo: string;
  installationId: number;
  parentSha: string;
  baseTreeSha: string;
  changes: Map<string, string | null>;
  message: string;
}): Promise<{ sha: string } | { error: string }> {
  const cfg = githubConfig();
  if (!cfg) return { error: M.githubUnavailable };
  const problem = checkCommit(input.changes);
  if (problem) return { error: problem };
  try {
    return await commitInitOnBase(
      { cfg, installationId: input.installationId, repo: input.repo },
      { parentSha: input.parentSha, baseTreeSha: input.baseTreeSha, changes: input.changes, message: input.message },
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

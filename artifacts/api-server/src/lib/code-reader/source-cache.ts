// Cache in memoria del codice delle app per Lucius: un SourceTree per app, valido finché lo sha del branch non cambia.
// Mai su disco. Nei log solo id dell'app, sha abbreviato, numero di file e durata: mai contenuti, token né percorsi.

import type { App } from "@workspace/db";
import { SourceTree, SourceTreeError } from "../architect/source-tree";
import { SourceError, fetchGithubTree } from "../architect/sources";
import { GithubError, forgetInstallationTokens, installationToken } from "../github/app";
import { fetchBranchSha } from "../github/commit";
import { githubConfig, type GithubConfig } from "../github/config";
import { logger } from "../logger";
import { userHasInstallation } from "../../routes/apps";
import { decryptSecret } from "../secrets";
import { CODE_MESSAGES } from "./messages";

const MAX_REPOS = 3;
const IDLE_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_API_BASE = "https://api.github.com";

export class CodeReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeReaderError";
  }
}

export interface AppSource {
  tree: SourceTree;
  /** null = commit non verificato (lo sha non si è potuto leggere). */
  sha: string | null;
  repo: string;
  branch: string | null;
}

interface Entry extends AppSource {
  lastUsed: number;
}

const entries = new Map<number, Entry>();
const inflight = new Map<number, Promise<AppSource>>();

interface TestOptions {
  githubConfig?: GithubConfig | null;
  githubApiBase?: string;
  now?: () => number;
}
let testOptions: TestOptions | null = null;

/** Solo per i test. */
export function setCodeCacheOptionsForTests(o: TestOptions | null): void {
  testOptions = o;
}

const now = (): number => (testOptions?.now ?? Date.now)();
const cfgNow = (): GithubConfig | null => (testOptions?.githubConfig !== undefined ? testOptions.githubConfig : githubConfig());

type Availability = { ok: true; repo: string; branch: string | null } | { ok: false; reason: string };

/** Accesso e sorgente GitHub dell'app, senza rete (passo 1 della spec): controllato a ogni chiamata. */
export async function codeAvailability(userId: number, app: App): Promise<Availability> {
  const unavailable = { ok: false, reason: CODE_MESSAGES.unavailable(app.name) } as const;
  if (app.sourceType !== "github" || !app.sourceRepo) return unavailable;
  if (app.sourceInstallationId != null) {
    if (!(await userHasInstallation(userId, app.sourceInstallationId))) return { ok: false, reason: CODE_MESSAGES.noAccess(app.name) };
  } else if (!app.sourceTokenEnc) {
    return unavailable;
  }
  return { ok: true, repo: app.sourceRepo, branch: app.sourceBranch ?? null };
}

async function evict(appId: number): Promise<void> {
  const e = entries.get(appId);
  entries.delete(appId);
  await e?.tree.dispose().catch(() => {});
}

function isNetworkError(err: SourceError): boolean {
  return err.status === null && /^(timeout|errore di rete|GitHub non raggiungibile)/.test(err.message);
}

function mapError(err: unknown, app: App): CodeReaderError {
  if (err instanceof CodeReaderError) return err;
  if (err instanceof SourceError) {
    if (err.status === 401) {
      if (app.sourceInstallationId != null) forgetInstallationTokens(app.sourceInstallationId);
      return new CodeReaderError(CODE_MESSAGES.revoked);
    }
    if (err.status === 404) return new CodeReaderError(CODE_MESSAGES.notFound);
    if (isNetworkError(err)) return new CodeReaderError(CODE_MESSAGES.unreachable);
    return new CodeReaderError(err.message);
  }
  if (err instanceof SourceTreeError || err instanceof GithubError) return new CodeReaderError(err.message);
  logger.error({ appId: app.id, errName: err instanceof Error ? err.name : "Error" }, "Lettura del codice non riuscita");
  return new CodeReaderError(CODE_MESSAGES.internal);
}

async function loadSource(app: App, repo: string, branch: string | null): Promise<AppSource> {
  let token: string;
  let apiBase: string;
  if (app.sourceInstallationId != null) {
    const cfg = cfgNow();
    if (!cfg) throw new CodeReaderError(CODE_MESSAGES.notConfigured);
    token = await installationToken(cfg, app.sourceInstallationId, { repo });
    apiBase = cfg.apiBase;
  } else {
    try {
      token = decryptSecret(app.sourceTokenEnc!);
    } catch {
      throw new CodeReaderError(CODE_MESSAGES.unavailable(app.name));
    }
    apiBase = testOptions?.githubApiBase ?? DEFAULT_API_BASE;
  }

  let sha: string | null = null;
  try {
    sha = await fetchBranchSha({ apiBase, repo, branch, token });
  } catch (err) {
    // Accesso revocato: niente riuso del repository in memoria
    if (err instanceof SourceError && err.status === 401) throw err;
    sha = null;
  }

  const hit = entries.get(app.id);
  if (hit && hit.repo === repo && hit.branch === branch && (sha === null || hit.sha === sha)) {
    hit.lastUsed = now();
    return { tree: hit.tree, sha: sha === null ? null : hit.sha, repo, branch };
  }

  const started = Date.now();
  const tree = await fetchGithubTree({ repo, branch, token, apiBase });
  await evict(app.id);
  entries.set(app.id, { tree, sha, repo, branch, lastUsed: now() });
  logger.info(
    { appId: app.id, sha7: sha?.slice(0, 7) ?? null, files: tree.fileCount, ms: Date.now() - started },
    "Codice dell'app scaricato",
  );
  while (entries.size > MAX_REPOS) {
    let oldest: number | null = null;
    for (const [id, e] of entries) {
      if (id !== app.id && (oldest === null || e.lastUsed < entries.get(oldest)!.lastUsed)) oldest = id;
    }
    if (oldest === null) break;
    await evict(oldest);
  }
  return { tree, sha, repo, branch };
}

/** Codice dell'app all'ultimo commit del branch, dalla cache o da GitHub. Lancia `CodeReaderError`. */
export async function getAppSource(userId: number, app: App): Promise<AppSource> {
  const avail = await codeAvailability(userId, app);
  if (!avail.ok) throw new CodeReaderError(avail.reason);
  let p = inflight.get(app.id);
  if (!p) {
    p = loadSource(app, avail.repo, avail.branch).finally(() => {
      inflight.delete(app.id);
    });
    inflight.set(app.id, p);
  }
  try {
    return await p;
  } catch (err) {
    throw mapError(err, app);
  }
}

/** Toglie i repository non usati da 15 minuti. */
export async function sweepCodeCache(at: number = now()): Promise<void> {
  for (const [id, e] of [...entries]) if (at - e.lastUsed >= IDLE_MS) await evict(id);
}

export async function clearCodeCache(): Promise<void> {
  for (const id of [...entries.keys()]) await evict(id);
}

export function startCodeCacheSweeper(): () => void {
  const timer = setInterval(() => {
    void sweepCodeCache().catch((err: unknown) =>
      logger.error({ errName: err instanceof Error ? err.name : "Error" }, "Pulizia della cache del codice non riuscita"),
    );
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

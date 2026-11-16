// Raccolta senza token del materiale per la sintesi dell'architettura di un'App: albero dell'ultimo commit (cache
// della lettura del codice), mappa deterministica, cambiamenti dal commit sintetizzato prima (solo titoli dei commit
// e file toccati, mai diff), descrizione funzionale e sintesi precedente. Nei log solo id e sha a 7.

import type { App } from "@workspace/db";
import { buildRepoMap } from "../architect/repo-map";
import { CODE_MESSAGES } from "../code-reader/messages";
import { CodeReaderError, codeReaderGithubConfig, getAppSource, type AppSource } from "../code-reader/source-cache";
import { compareCommits, getDefaultBranch, type CommitComparison, type RepoRef } from "../code-writer/github-git";
import { CODE_WRITE_MESSAGES, CodeWriteError } from "../code-writer/messages";
import { logger } from "../logger";
import { ARCH_MESSAGES } from "./messages";

/** Descrizione funzionale dell'App riportata nel materiale. */
export const FUNCTIONAL_MAX_CHARS = 12_000;

/** Errore della raccolta con un messaggio fisso di `ARCH_MESSAGES` (o della lettura del codice). */
export class ArchitectureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchitectureError";
  }
}

export interface Materials {
  sha: string;
  branch: string;
  source: AppSource;
  repoMap: string;
  /** Vero per la prima sintesi o quando il confronto con lo SHA precedente non è possibile (storia riscritta). */
  full: boolean;
  /** Titoli dei commit dal più vecchio al più recente (al più 30). */
  commits: string[];
  files: CommitComparison["files"];
  truncated: boolean;
  functional: string;
  previousSummary: string | null;
}

export interface CollectInput {
  userId: number;
  app: App;
  previousSha: string | null;
  previousSummary: string | null;
}

function fromCodeReader(err: CodeReaderError, app: App): ArchitectureError {
  switch (err.message) {
    case CODE_MESSAGES.unreachable:
      return new ArchitectureError(ARCH_MESSAGES.githubDown);
    case CODE_MESSAGES.revoked:
    case CODE_MESSAGES.noAccess(app.name):
      return new ArchitectureError(ARCH_MESSAGES.noAccess);
    case CODE_MESSAGES.unavailable(app.name):
    case CODE_MESSAGES.notConfigured:
      return new ArchitectureError(ARCH_MESSAGES.noGithub);
    case CODE_MESSAGES.internal:
      return new ArchitectureError(ARCH_MESSAGES.internal);
    default:
      // Messaggi fissi della lettura del codice (es. «repository o branch non trovato»)
      return new ArchitectureError(err.message);
  }
}

function fromCodeWriter(err: unknown, app: App): ArchitectureError {
  if (err instanceof CodeWriteError) {
    return new ArchitectureError(err.message === CODE_WRITE_MESSAGES.unavailable ? ARCH_MESSAGES.githubDown : ARCH_MESSAGES.noAccess);
  }
  logger.error({ appId: app.id, errName: err instanceof Error ? err.name : "Error" }, "Raccolta dell'architettura non riuscita");
  return new ArchitectureError(ARCH_MESSAGES.internal);
}

/** Materiale della sintesi. Lancia `ArchitectureError` con un messaggio fisso. */
export async function collectMaterials(input: CollectInput): Promise<Materials> {
  const { app, userId } = input;
  const cfg = codeReaderGithubConfig();
  if (app.sourceType !== "github" || !app.sourceRepo || app.sourceInstallationId == null) {
    throw new ArchitectureError(ARCH_MESSAGES.noGithub);
  }
  if (!cfg) throw new ArchitectureError(ARCH_MESSAGES.noGithub);
  const ref: RepoRef = { cfg, installationId: app.sourceInstallationId, repo: app.sourceRepo };

  let source: AppSource;
  try {
    source = await getAppSource(userId, app);
  } catch (err) {
    if (err instanceof CodeReaderError) throw fromCodeReader(err, app);
    throw fromCodeWriter(err, app);
  }
  // Senza uno sha verificato non si sa quale commit si descrive
  if (!source.sha) throw new ArchitectureError(ARCH_MESSAGES.githubDown);
  const sha = source.sha;

  let branch = source.branch;
  let comparison: CommitComparison | null = null;
  try {
    branch ??= await getDefaultBranch(ref);
    // Senza sintesi precedente non c'è nulla da aggiornare: si riparte da capo
    if (input.previousSha && input.previousSummary && input.previousSha !== sha) {
      comparison = await compareCommits(ref, input.previousSha, sha);
    }
  } catch (err) {
    throw fromCodeWriter(err, app);
  }

  const update = input.previousSha != null && input.previousSummary != null && (input.previousSha === sha || comparison !== null);
  logger.info(
    {
      appId: app.id,
      sha7: sha.slice(0, 7),
      full: !update,
      commits: comparison?.commits.length ?? 0,
      files: comparison?.files.length ?? 0,
    },
    "Materiale dell'architettura raccolto",
  );
  return {
    sha,
    branch,
    source,
    repoMap: buildRepoMap(source.tree, null),
    full: !update,
    commits: comparison?.commits ?? [],
    files: comparison?.files ?? [],
    truncated: comparison?.truncated ?? false,
    functional: (app.functionalDescription ?? "").slice(0, FUNCTIONAL_MAX_CHARS),
    previousSummary: input.previousSummary,
  };
}

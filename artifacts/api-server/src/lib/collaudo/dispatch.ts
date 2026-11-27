// Lancio del workflow di collaudo con `workflow_dispatch`

import { githubCall, installationToken, repoInstallationId } from "../github/app";
import { githubConfig } from "../github/config";
import { logger } from "../logger";
import { COLLAUDO_WORKFLOW, collaudoRepo } from "./config";
import { COLLAUDO_MESSAGES } from "./messages";

const FAILED = { ok: false, error: COLLAUDO_MESSAGES.dispatchFailed } as const;

/** Avvia il workflow del repository di collaudo per il collaudo `testId`; mai eccezioni, errore con messaggio fisso. */
export async function dispatchTest(testId: number, code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const cfg = githubConfig();
  const repo = collaudoRepo();
  if (!cfg || !repo) return FAILED;
  try {
    const installationId = await repoInstallationId(cfg, repo);
    if (installationId === null) return FAILED;
    const token = await installationToken(cfg, installationId, { repo, permissions: { actions: "write" } });
    const [owner, name] = repo.split("/") as [string, string];
    const { status } = await githubCall(cfg, {
      base: "api",
      method: "POST",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${COLLAUDO_WORKFLOW}/dispatches`,
      token,
      body: { ref: "main", inputs: { collaudo: String(testId), codice: code } },
    });
    if (status >= 200 && status < 300) return { ok: true };
    logger.warn({ testId, status }, "lancio del collaudo rifiutato da GitHub");
    return FAILED;
  } catch {
    logger.warn({ testId }, "lancio del collaudo non riuscito");
    return FAILED;
  }
}

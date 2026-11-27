// Stato della configurazione del collaudo, per Account

import { githubCall, installationToken, repoInstallationId } from "../github/app";
import { githubConfig } from "../github/config";
import { COLLAUDO_WORKFLOW, collaudoRepo } from "./config";

export interface CollaudoSetup {
  repo: string | null;
  /** L'App GitHub è installata sul repository di collaudo. */
  installed: boolean;
  /** Il file del workflow esiste nel repository. */
  workflow: boolean;
  /** GitHub concede il permesso `actions: write` sul repository. */
  actionsWrite: boolean;
}

/** Cosa manca per collaudare: nessuna chiamata distruttiva, mai eccezioni. */
export async function collaudoSetup(): Promise<CollaudoSetup> {
  const repo = collaudoRepo();
  const out: CollaudoSetup = { repo, installed: false, workflow: false, actionsWrite: false };
  const cfg = githubConfig();
  if (!repo || !cfg) return out;
  const [owner, name] = repo.split("/") as [string, string];
  try {
    const installationId = await repoInstallationId(cfg, repo);
    if (installationId === null) return out;
    out.installed = true;
    try {
      const token = await installationToken(cfg, installationId, { repo });
      const { status } = await githubCall(cfg, {
        base: "api",
        method: "GET",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/.github/workflows/${COLLAUDO_WORKFLOW}`,
        token,
      });
      out.workflow = status >= 200 && status < 300;
    } catch {
      /* resta false */
    }
    try {
      await installationToken(cfg, installationId, { repo, permissions: { actions: "write" } });
      out.actionsWrite = true;
    } catch {
      /* permesso non concesso */
    }
  } catch {
    /* GitHub non raggiungibile: lo stato resta quello raccolto */
  }
  return out;
}

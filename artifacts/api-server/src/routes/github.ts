import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, githubInstallationsTable } from "@workspace/db";
import { ListGithubInstallationsResponse, ListGithubReposResponse } from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { GITHUB_MESSAGES, GithubError, forgetInstallationTokens, listInstallationRepos } from "../lib/github/app";
import { githubConfig, type GithubConfig } from "../lib/github/config";
import { logger } from "../lib/logger";

// Installazioni dell'App GitHub dell'utente e repository che l'App vede: base per scegliere la
// sorgente di un'app e per la console. Nessun token esce da qui.

/** Pagina di GitHub in cui gestire un'installazione (diversa per account personali e organizzazioni). */
function manageUrl(cfg: GithubConfig, accountType: string, accountLogin: string, installationId: number): string {
  return accountType === "Organization"
    ? `${cfg.webBase}/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${installationId}`
    : `${cfg.webBase}/settings/installations/${installationId}`;
}

/**
 * Installazione revocata o rimossa: `access_tokens` risponde 404, oppure l'elenco dei repo risponde
 * 401 al token di installazione (ottenuto da GitHub, quindi le credenziali dell'App sono buone).
 * Un 401 sul JWT dell'App arriva come "GitHub non risponde" (credenziali dell'App rifiutate) e non
 * elimina nulla; ogni altro errore è un problema temporaneo.
 */
function isRevoked(err: unknown): boolean {
  return err instanceof GithubError && err.message === GITHUB_MESSAGES.noAccess && (err.status === 401 || err.status === 404);
}

/**
 * Installazione che GitHub rifiuta senza averla rimossa (403/422, es. sospesa dal proprietario):
 * non si elimina, si salta solo in questo elenco. I limiti di richieste arrivano come "GitHub non
 * risponde" e non passano di qui.
 */
function isRefused(err: unknown): err is GithubError {
  return err instanceof GithubError && err.message === GITHUB_MESSAGES.noAccess && !isRevoked(err);
}

const router: IRouter = Router();

router.get("/github/installations", async (req, res) => {
  const cfg = githubConfig();
  if (!cfg) {
    res.status(404).json({ error: GITHUB_MESSAGES.notConfigured });
    return;
  }
  const rows = await db
    .select()
    .from(githubInstallationsTable)
    .where(eq(githubInstallationsTable.userId, currentUserId(req)))
    .orderBy(asc(githubInstallationsTable.installationId));
  res.json(
    ListGithubInstallationsResponse.parse({
      installUrl: `${cfg.webBase}/apps/${encodeURIComponent(cfg.slug)}/installations/new`,
      installations: rows.map((r) => ({
        installationId: r.installationId,
        accountLogin: r.accountLogin,
        accountType: r.accountType,
        repositorySelection: r.repositorySelection,
        manageUrl: manageUrl(cfg, r.accountType, r.accountLogin, r.installationId),
      })),
    }),
  );
});

router.get("/github/repos", async (req, res) => {
  const cfg = githubConfig();
  if (!cfg) {
    res.status(404).json({ error: GITHUB_MESSAGES.notConfigured });
    return;
  }
  const userId = currentUserId(req);
  const installations = await db
    .select({ installationId: githubInstallationsTable.installationId })
    .from(githubInstallationsTable)
    .where(eq(githubInstallationsTable.userId, userId))
    .orderBy(asc(githubInstallationsTable.installationId));

  // In sequenza: le installazioni di un utente sono poche
  const all: { installationId: number; fullName: string; defaultBranch: string; private: boolean }[] = [];
  for (const { installationId } of installations) {
    try {
      for (const repo of await listInstallationRepos(cfg, installationId)) all.push({ installationId, ...repo });
    } catch (err) {
      if (isRevoked(err)) {
        // Revocata: si elimina per l'utente e si prosegue con le altre
        forgetInstallationTokens(installationId);
        await db
          .delete(githubInstallationsTable)
          .where(and(eq(githubInstallationsTable.userId, userId), eq(githubInstallationsTable.installationId, installationId)));
        continue;
      }
      if (isRefused(err)) {
        // Sospesa o rifiutata: la riga resta, gli altri repo arrivano lo stesso
        logger.warn({ installationId, status: err.status }, "Installazione GitHub rifiutata: saltata nell'elenco dei repo");
        continue;
      }
      if (err instanceof GithubError) {
        res.status(502).json({ error: GITHUB_MESSAGES.unavailable });
        return;
      }
      throw err;
    }
  }

  // Confronto per codice (indipendente dalla lingua); ordinamento stabile: a parità vince la prima installazione
  all.sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
  const seen = new Set<string>();
  const unique = all.filter((r) => !seen.has(r.fullName) && !!seen.add(r.fullName));
  res.json(ListGithubReposResponse.parse(unique));
});

export default router;

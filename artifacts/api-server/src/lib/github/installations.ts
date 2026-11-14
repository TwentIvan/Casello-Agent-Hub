// Installazioni dell'App GitHub viste dall'utente: a ogni callback valida si salvano tutte e sole
// quelle restituite da GitHub con il token utente appena ottenuto, con i repo di ognuna che l'utente
// vede davvero (nessun token salvato).

import { and, eq, notInArray, sql } from "drizzle-orm";
import { db, githubInstallationsTable } from "@workspace/db";
import { GithubError, listUserInstallationRepos, listUserInstallations } from "./app";
import type { GithubConfig } from "./config";

/**
 * Sostituisce le installazioni dell'utente con quelle visibili su GitHub: inserisce le nuove,
 * aggiorna le esistenti ed elimina quelle non più visibili, in una transazione. Per ognuna salva i
 * repo che l'utente vede (`user_repos`); se GitHub non risponde per un'installazione, il suo elenco
 * resta quello di prima (null per una nuova: non verificato). Il token si usa solo per la lettura e
 * non esce da qui.
 */
export async function syncInstallations(cfg: GithubConfig, userId: number, userToken: string): Promise<void> {
  // Lettura fuori dalla transazione: nessuna connessione al DB tenuta aperta durante le chiamate HTTP
  const visible = await listUserInstallations(cfg, userToken);
  const ids = [...new Set(visible.map((i) => i.installationId))];
  const userRepos = new Map<number, string[]>();
  for (const id of ids) {
    try {
      userRepos.set(id, await listUserInstallationRepos(cfg, userToken, id));
    } catch (err) {
      if (!(err instanceof GithubError)) throw err;
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(githubInstallationsTable)
      .where(
        ids.length > 0
          ? and(eq(githubInstallationsTable.userId, userId), notInArray(githubInstallationsTable.installationId, ids))
          : eq(githubInstallationsTable.userId, userId),
      );
    for (const inst of visible) {
      const repos = userRepos.get(inst.installationId);
      const checked = repos !== undefined ? { userRepos: repos, userReposCheckedAt: sql`now()` } : {};
      await tx
        .insert(githubInstallationsTable)
        .values({
          userId,
          installationId: inst.installationId,
          accountLogin: inst.accountLogin,
          accountType: inst.accountType,
          repositorySelection: inst.repositorySelection,
          ...checked,
        })
        .onConflictDoUpdate({
          target: [githubInstallationsTable.userId, githubInstallationsTable.installationId],
          set: {
            accountLogin: inst.accountLogin,
            accountType: inst.accountType,
            repositorySelection: inst.repositorySelection,
            ...checked,
            updatedAt: sql`now()`,
          },
        });
    }
  });
}

/** Messaggio della spec per un'installazione che non c'è, non è dell'utente o non vede il repo. */
export const INSTALLATION_NOT_YOURS = "installazione non trovata o non tua";

/** L'utente ha collegato quell'installazione (riga in `github_installations`). */
export async function userHasInstallation(userId: number, installationId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: githubInstallationsTable.id })
    .from(githubInstallationsTable)
    .where(and(eq(githubInstallationsTable.userId, userId), eq(githubInstallationsTable.installationId, installationId)))
    .limit(1);
  return !!row;
}

/** Messaggio per un repo che l'installazione vede ma l'utente no. */
export const REPO_NOT_VISIBLE = "repository non accessibile al tuo account GitHub: scegli un repo che vedi su GitHub";
/** Messaggio per un'installazione i cui repo non sono ancora stati verificati con il token dell'utente. */
export const REPOS_NOT_VERIFIED = "accesso ai repository non ancora verificato: ricollega GitHub da Account";

export type RepoAccess = "ok" | "no_installation" | "not_verified" | "not_visible";

/**
 * L'utente vede davvero quel repo su GitHub tramite quell'installazione: riga dell'installazione
 * presente e repo (senza distinguere le maiuscole) tra quelli letti con il suo token.
 */
export async function userRepoAccess(userId: number, installationId: number, repo: string): Promise<RepoAccess> {
  const [row] = await db
    .select({ userRepos: githubInstallationsTable.userRepos })
    .from(githubInstallationsTable)
    .where(and(eq(githubInstallationsTable.userId, userId), eq(githubInstallationsTable.installationId, installationId)))
    .limit(1);
  if (!row) return "no_installation";
  if (!Array.isArray(row.userRepos)) return "not_verified";
  return row.userRepos.includes(repo.toLowerCase()) ? "ok" : "not_visible";
}

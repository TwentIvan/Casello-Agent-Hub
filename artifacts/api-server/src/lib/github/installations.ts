// Installazioni dell'App GitHub viste dall'utente: a ogni callback valida si salvano tutte e sole
// quelle restituite da GitHub con il token utente appena ottenuto (nessun token salvato).

import { and, eq, notInArray, sql } from "drizzle-orm";
import { db, githubInstallationsTable } from "@workspace/db";
import { listUserInstallations } from "./app";
import type { GithubConfig } from "./config";

/**
 * Sostituisce le installazioni dell'utente con quelle visibili su GitHub: inserisce le nuove,
 * aggiorna le esistenti ed elimina quelle non più visibili, in una transazione. Il token si usa
 * solo per la lettura e non esce da qui.
 */
export async function syncInstallations(cfg: GithubConfig, userId: number, userToken: string): Promise<void> {
  // Lettura fuori dalla transazione: nessuna connessione al DB tenuta aperta durante le chiamate HTTP
  const visible = await listUserInstallations(cfg, userToken);
  const ids = [...new Set(visible.map((i) => i.installationId))];

  await db.transaction(async (tx) => {
    await tx
      .delete(githubInstallationsTable)
      .where(
        ids.length > 0
          ? and(eq(githubInstallationsTable.userId, userId), notInArray(githubInstallationsTable.installationId, ids))
          : eq(githubInstallationsTable.userId, userId),
      );
    for (const inst of visible) {
      await tx
        .insert(githubInstallationsTable)
        .values({
          userId,
          installationId: inst.installationId,
          accountLogin: inst.accountLogin,
          accountType: inst.accountType,
          repositorySelection: inst.repositorySelection,
        })
        .onConflictDoUpdate({
          target: [githubInstallationsTable.userId, githubInstallationsTable.installationId],
          set: {
            accountLogin: inst.accountLogin,
            accountType: inst.accountType,
            repositorySelection: inst.repositorySelection,
            updatedAt: sql`now()`,
          },
        });
    }
  });
}

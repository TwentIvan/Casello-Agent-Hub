// Collegamenti OAuth (app come Claude collegate a /mcp): elenco, revoca e pulizia periodica.

import { and, desc, eq, isNull, lt, ne, notExists, sql } from "drizzle-orm";
import { db, oauthClientsTable, oauthCodesTable, oauthGrantsTable, oauthTokensTable } from "@workspace/db";
import { logger } from "../logger";
import { originOfEmbedClient } from "../embed/origins";

export const OAUTH_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const REVOKED_KEEP_MS = 30 * DAY_MS;

export const OAUTH_GRANT_MESSAGES = { notFound: "collegamento non trovato" } as const;

export type OAuthGrantView = {
  id: number;
  clientName: string;
  redirectHost: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  canDecide: boolean;
};

/** Host mostrato: per i client `embed` quello dell'app ospite (il ritorno è sempre su Botcave), per gli altri quello del ritorno. */
function hostOf(uris: string[], clientId: string): string {
  try {
    const origin = originOfEmbedClient(clientId);
    if (origin !== null) return new URL(origin).host;
    return new URL(uris[0] ?? "").host;
  } catch {
    return "";
  }
}

/** Collegamenti non revocati dell'utente, dal più recente. */
export async function listGrants(userId: number): Promise<OAuthGrantView[]> {
  const rows = await db
    .select({
      id: oauthGrantsTable.id,
      scopes: oauthGrantsTable.scopes,
      createdAt: oauthGrantsTable.createdAt,
      lastUsedAt: oauthGrantsTable.lastUsedAt,
      clientName: oauthClientsTable.name,
      redirectUris: oauthClientsTable.redirectUris,
      clientId: oauthClientsTable.clientId,
    })
    .from(oauthGrantsTable)
    .innerJoin(oauthClientsTable, eq(oauthClientsTable.id, oauthGrantsTable.clientRowId))
    .where(and(eq(oauthGrantsTable.userId, userId), isNull(oauthGrantsTable.revokedAt)))
    .orderBy(desc(oauthGrantsTable.createdAt), desc(oauthGrantsTable.id));
  return rows.map((r) => ({
    id: r.id,
    clientName: r.clientName,
    redirectHost: hostOf(r.redirectUris, r.clientId),
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    // Il pannello incorporabile (ambito embed) approva e rifiuta come il connettore con api:write
    canDecide: r.scopes.includes("api:write") || r.scopes.includes("embed"),
  }));
}

/** Revoca (vale alla richiesta successiva). false se non è dell'utente o è già revocato. */
export async function revokeGrant(userId: number, id: number): Promise<boolean> {
  const done = await db
    .update(oauthGrantsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthGrantsTable.id, id), eq(oauthGrantsTable.userId, userId), isNull(oauthGrantsTable.revokedAt)))
    .returning({ id: oauthGrantsTable.id });
  return done.length > 0;
}

/** Pulizia: codici e token scaduti da oltre un giorno, collegamenti revocati da oltre 30 giorni, client senza collegamenti da oltre 24 h. */
export async function sweepOAuth(now: Date = new Date()): Promise<void> {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  await db.delete(oauthCodesTable).where(lt(oauthCodesTable.expiresAt, dayAgo));
  await db.delete(oauthTokensTable).where(lt(oauthTokensTable.expiresAt, dayAgo));
  await db.delete(oauthGrantsTable).where(lt(oauthGrantsTable.revokedAt, new Date(now.getTime() - REVOKED_KEEP_MS)));
  await db
    .delete(oauthClientsTable)
    .where(
      and(
        lt(oauthClientsTable.createdAt, dayAgo),
        ne(oauthClientsTable.kind, "embed"), // i client del plugin li gestisce EMBED_ALLOWED_ORIGINS
        notExists(db.select({ one: sql`1` }).from(oauthGrantsTable).where(eq(oauthGrantsTable.clientRowId, oauthClientsTable.id))),
      ),
    );
}

/** Pulizia all'avvio e ogni ora; un errore si registra col solo nome. */
export function startOAuthSweeper(): () => void {
  const run = () =>
    void sweepOAuth().catch((err: unknown) =>
      logger.error({ errName: err instanceof Error ? err.name : "Error" }, "Pulizia OAuth non riuscita"),
    );
  run();
  const timer = setInterval(run, OAUTH_SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

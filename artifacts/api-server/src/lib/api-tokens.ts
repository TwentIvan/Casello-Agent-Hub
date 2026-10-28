// Token personali per gli agenti locali (server MCP): `cas_` + 32 byte casuali in base64url, mostrati
// una sola volta alla creazione; a riposo solo l'hash SHA-256 esadecimale. Mai nei log: né il token,
// né il suo hash, né l'header Authorization.

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { db, apiTokensTable, usersTable, type ApiToken } from "@workspace/db";
import { isAllowed } from "./users";

const TOKEN_PREFIX = "cas_";
const NAME_MAX = 100;
const DAYS_MIN = 1;
const DAYS_MAX = 90;
const DAY_MS = 86_400_000;
/** lastUsedAt si aggiorna al massimo una volta al minuto. */
const LAST_USED_GRANULARITY_MS = 60_000;

/** Nome o durata non validi: il messaggio, in italiano, va nel 400. */
export class ApiTokenInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiTokenInputError";
  }
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Crea un token per l'utente. Il valore in chiaro esce solo da qui. */
export async function createApiToken(
  userId: number,
  name: string,
  expiresInDays: number,
): Promise<{ token: string; row: ApiToken }> {
  const cleanName = name.trim();
  if (cleanName.length < 1 || cleanName.length > NAME_MAX) {
    throw new ApiTokenInputError(`nome obbligatorio, al massimo ${NAME_MAX} caratteri`);
  }
  if (!Number.isInteger(expiresInDays) || expiresInDays < DAYS_MIN || expiresInDays > DAYS_MAX) {
    throw new ApiTokenInputError(`la scadenza deve essere un numero intero di giorni tra ${DAYS_MIN} e ${DAYS_MAX}`);
  }
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(apiTokensTable)
    .values({
      userId,
      tokenHash: hashToken(token),
      name: cleanName,
      expiresAt: new Date(Date.now() + expiresInDays * DAY_MS),
    })
    .returning();
  return { token, row: row! };
}

/** Token dell'utente, i più recenti prima, revocati compresi. */
export async function listApiTokens(userId: number): Promise<ApiToken[]> {
  return db
    .select()
    .from(apiTokensTable)
    .where(eq(apiTokensTable.userId, userId))
    .orderBy(desc(apiTokensTable.createdAt), desc(apiTokensTable.id));
}

/** Revoca un token dell'utente; false se non è suo o è già revocato. */
export async function revokeApiToken(userId: number, id: number): Promise<boolean> {
  const rows = await db
    .update(apiTokensTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokensTable.id, id), eq(apiTokensTable.userId, userId), isNull(apiTokensTable.revokedAt)))
    .returning({ id: apiTokensTable.id });
  return rows.length > 0;
}

/**
 * Utente di un token, o null se è sconosciuto, revocato, scaduto o se l'email dell'utente non è più
 * ammessa (ALLOWED_EMAILS). Aggiorna lastUsedAt al massimo una volta al minuto.
 */
export async function authenticateApiToken(
  raw: string,
  now: Date = new Date(),
): Promise<{ userId: number; tokenId: number } | null> {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const [found] = await db
    .select({ token: apiTokensTable, email: usersTable.email })
    .from(apiTokensTable)
    .innerJoin(usersTable, eq(usersTable.id, apiTokensTable.userId))
    .where(eq(apiTokensTable.tokenHash, hashToken(raw)));
  if (!found) return null;
  const { token, email } = found;
  if (token.revokedAt || token.expiresAt.getTime() <= now.getTime()) return null;
  if (!isAllowed([email])) return null;

  // UPDATE condizionale: due richieste vicine non scrivono entrambe
  const threshold = new Date(now.getTime() - LAST_USED_GRANULARITY_MS);
  await db
    .update(apiTokensTable)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(apiTokensTable.id, token.id),
        or(isNull(apiTokensTable.lastUsedAt), lt(apiTokensTable.lastUsedAt, threshold)),
      ),
    );
  return { userId: token.userId, tokenId: token.id };
}

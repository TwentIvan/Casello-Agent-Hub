// Token personali per gli agenti locali (server MCP e /api): `cas_` + 32 byte casuali in base64url, mostrati
// una sola volta alla creazione; a riposo solo l'hash SHA-256 esadecimale. Mai nei log: né il token,
// né il suo hash, né l'header Authorization.

import type { Request } from "express";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { db, apiTokensTable, usersTable, type ApiToken } from "@workspace/db";
import { isAllowed } from "./users";

const TOKEN_PREFIX = "cas_";
/** Ambiti di un token: mcp = server MCP; api:read = lettura su /api; api:write = lettura e scrittura su /api. */
export const TOKEN_SCOPES = ["mcp", "api:read", "api:write"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

const NAME_MAX = 100;
const DAYS_MIN = 1;
const DAYS_MAX = 90;
const DAY_MS = 86_400_000;
/** lastUsedAt si aggiorna al massimo una volta al minuto. */
const LAST_USED_GRANULARITY_MS = 60_000;

/** Nome, durata o ambiti non validi: il messaggio, in italiano, va nel 400. */
export class ApiTokenInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiTokenInputError";
  }
}

/** Token dall'header `Authorization: Bearer <token>` (schema senza badare alle maiuscole), o null. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1]! : null;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Crea un token per l'utente. Il valore in chiaro esce solo da qui. */
export async function createApiToken(
  userId: number,
  name: string,
  expiresInDays: number,
  scopes: TokenScope[] = ["mcp"],
): Promise<{ token: string; row: ApiToken }> {
  const cleanName = name.trim();
  if (cleanName.length < 1 || cleanName.length > NAME_MAX) {
    throw new ApiTokenInputError(`nome obbligatorio, al massimo ${NAME_MAX} caratteri`);
  }
  if (!Number.isInteger(expiresInDays) || expiresInDays < DAYS_MIN || expiresInDays > DAYS_MAX) {
    throw new ApiTokenInputError(`la scadenza deve essere un numero intero di giorni tra ${DAYS_MIN} e ${DAYS_MAX}`);
  }
  const known = scopes.filter((scope) => TOKEN_SCOPES.includes(scope));
  if (scopes.length < 1 || known.length !== scopes.length || new Set(scopes).size !== scopes.length) {
    throw new ApiTokenInputError(`ambiti non validi: scegline almeno uno tra ${TOKEN_SCOPES.join(", ")}`);
  }
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(apiTokensTable)
    .values({
      userId,
      tokenHash: hashToken(token),
      name: cleanName,
      expiresAt: new Date(Date.now() + expiresInDays * DAY_MS),
      scopes: TOKEN_SCOPES.filter((scope) => scopes.includes(scope)),
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
): Promise<{ userId: number; tokenId: number; scopes: TokenScope[] } | null> {
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
  return { userId: token.userId, tokenId: token.id, scopes: token.scopes as TokenScope[] };
}

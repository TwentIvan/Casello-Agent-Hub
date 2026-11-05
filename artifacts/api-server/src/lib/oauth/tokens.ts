import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db, oauthClientsTable, oauthCodesTable, oauthGrantsTable, oauthTokensTable, usersTable } from "@workspace/db";
import type { TokenScope } from "../api-tokens";
import { isAllowed } from "../users";
import { sha256Hex } from "./authorize";
import { oauthBase } from "./config";
import { OAuthError } from "./errors";

export const ACCESS_TTL_MS = 3600 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const LAST_USED_STEP_MS = 60 * 1000;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: 3600;
  refresh_token: string;
  scope: "mcp";
};

const invalidGrant = () => new OAuthError("invalid_grant", "codice o token non valido, scaduto o già usato");

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function required(form: Record<string, unknown>, name: string): string {
  const v = str(form[name]);
  if (v === undefined) throw new OAuthError("invalid_request", `parametro mancante: ${name}`);
  return v;
}

function checkResource(form: Record<string, unknown>): void {
  if (form["resource"] !== undefined && form["resource"] !== oauthBase().resource) {
    throw new OAuthError("invalid_target", "risorsa non valida");
  }
}

async function findClientRowId(clientId: string): Promise<number> {
  const [row] = await db.select({ id: oauthClientsTable.id }).from(oauthClientsTable).where(eq(oauthClientsTable.clientId, clientId));
  if (!row) throw new OAuthError("invalid_client", "applicazione non riconosciuta", 401);
  return row.id;
}

type TokenTx = Pick<typeof db, "insert">;

/** Inserisce la coppia di token (solo gli hash nel DB) e restituisce la risposta con i valori in chiaro. */
async function issuePair(tx: TokenTx, grantId: number): Promise<TokenResponse> {
  const access = `cao_${randomBytes(32).toString("base64url")}`;
  const refresh = `car_${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  await tx.insert(oauthTokensTable).values([
    { tokenHash: sha256Hex(access), grantId, kind: "access", expiresAt: new Date(now + ACCESS_TTL_MS) },
    { tokenHash: sha256Hex(refresh), grantId, kind: "refresh", expiresAt: new Date(now + REFRESH_TTL_MS) },
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "mcp" };
}

/** Scambio del codice d'autorizzazione (PKCE S256, client pubblico). */
export async function exchangeCode(form: Record<string, unknown>): Promise<TokenResponse> {
  const code = required(form, "code");
  const redirectUri = required(form, "redirect_uri");
  const clientId = required(form, "client_id");
  const verifier = required(form, "code_verifier");
  if (!VERIFIER_RE.test(verifier)) throw new OAuthError("invalid_request", "code_verifier non valido");
  checkResource(form);
  const clientRowId = await findClientRowId(clientId);

  const [row] = await db
    .select({
      id: oauthCodesTable.id,
      grantId: oauthCodesTable.grantId,
      redirectUri: oauthCodesTable.redirectUri,
      codeChallenge: oauthCodesTable.codeChallenge,
      expiresAt: oauthCodesTable.expiresAt,
      usedAt: oauthCodesTable.usedAt,
      grantClientRowId: oauthGrantsTable.clientRowId,
      revokedAt: oauthGrantsTable.revokedAt,
    })
    .from(oauthCodesTable)
    .innerJoin(oauthGrantsTable, eq(oauthGrantsTable.id, oauthCodesTable.grantId))
    .where(eq(oauthCodesTable.codeHash, sha256Hex(code)));
  if (
    !row ||
    row.usedAt !== null ||
    row.revokedAt !== null ||
    row.expiresAt.getTime() <= Date.now() ||
    row.grantClientRowId !== clientRowId ||
    row.redirectUri !== redirectUri ||
    createHash("sha256").update(verifier).digest("base64url") !== row.codeChallenge
  ) {
    throw invalidGrant();
  }

  // Consumo + emissione in una transazione: vince una sola richiesta
  const out = await db.transaction(async (tx) => {
    const won = await tx
      .update(oauthCodesTable)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthCodesTable.id, row.id), isNull(oauthCodesTable.usedAt), gt(oauthCodesTable.expiresAt, new Date())))
      .returning({ id: oauthCodesTable.id });
    if (won.length === 0) return null;
    return issuePair(tx, row.grantId);
  });
  if (!out) throw invalidGrant();
  return out;
}

/** Rinnovo con rotazione: un token di rinnovo già usato revoca l'intero collegamento. */
export async function refreshTokens(form: Record<string, unknown>): Promise<TokenResponse> {
  const refresh = required(form, "refresh_token");
  const clientId = required(form, "client_id");
  const clientRowId = await findClientRowId(clientId);

  const [row] = await db
    .select({
      id: oauthTokensTable.id,
      grantId: oauthTokensTable.grantId,
      kind: oauthTokensTable.kind,
      expiresAt: oauthTokensTable.expiresAt,
      usedAt: oauthTokensTable.usedAt,
      grantClientRowId: oauthGrantsTable.clientRowId,
      revokedAt: oauthGrantsTable.revokedAt,
      email: usersTable.email,
    })
    .from(oauthTokensTable)
    .innerJoin(oauthGrantsTable, eq(oauthGrantsTable.id, oauthTokensTable.grantId))
    .innerJoin(usersTable, eq(usersTable.id, oauthGrantsTable.userId))
    .where(eq(oauthTokensTable.tokenHash, sha256Hex(refresh)));
  if (!row || row.kind !== "refresh" || row.grantClientRowId !== clientRowId || row.revokedAt !== null) throw invalidGrant();

  const revoke = async (): Promise<never> => {
    await db.transaction(async (tx) => {
      await tx
        .update(oauthGrantsTable)
        .set({ revokedAt: new Date() })
        .where(and(eq(oauthGrantsTable.id, row.grantId), isNull(oauthGrantsTable.revokedAt)));
    });
    throw invalidGrant();
  };

  if (row.usedAt !== null) return revoke(); // riuso: probabile furto
  if (row.expiresAt.getTime() <= Date.now() || !isAllowed([row.email])) throw invalidGrant();

  const out = await db.transaction(async (tx) => {
    const won = await tx
      .update(oauthTokensTable)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthTokensTable.id, row.id), isNull(oauthTokensTable.usedAt), gt(oauthTokensTable.expiresAt, new Date())))
      .returning({ id: oauthTokensTable.id });
    if (won.length === 0) return null;
    return issuePair(tx, row.grantId);
  });
  // Perso la corsa: un'altra richiesta ha già usato questo token di rinnovo
  if (!out) return revoke();
  return out;
}

/** Verifica un token d'accesso `cao_…`: null se sconosciuto, scaduto, revocato o utente non più ammesso. */
export async function verifyAccessToken(
  raw: string,
): Promise<{ userId: number; grantId: number; scopes: TokenScope[] } | null> {
  if (!raw.startsWith("cao_")) return null;
  const [row] = await db
    .select({
      grantId: oauthGrantsTable.id,
      userId: oauthGrantsTable.userId,
      scopes: oauthGrantsTable.scopes,
      lastUsedAt: oauthGrantsTable.lastUsedAt,
      email: usersTable.email,
    })
    .from(oauthTokensTable)
    .innerJoin(oauthGrantsTable, eq(oauthGrantsTable.id, oauthTokensTable.grantId))
    .innerJoin(usersTable, eq(usersTable.id, oauthGrantsTable.userId))
    .where(
      and(
        eq(oauthTokensTable.tokenHash, sha256Hex(raw)),
        eq(oauthTokensTable.kind, "access"),
        gt(oauthTokensTable.expiresAt, new Date()),
        isNull(oauthGrantsTable.revokedAt),
      ),
    );
  if (!row || !isAllowed([row.email])) return null;

  if (row.lastUsedAt === null || Date.now() - row.lastUsedAt.getTime() >= LAST_USED_STEP_MS) {
    const threshold = new Date(Date.now() - LAST_USED_STEP_MS);
    await db
      .update(oauthGrantsTable)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(oauthGrantsTable.id, row.grantId),
          or(isNull(oauthGrantsTable.lastUsedAt), lt(oauthGrantsTable.lastUsedAt, threshold)),
        ),
      );
  }
  return { userId: row.userId, grantId: row.grantId, scopes: row.scopes as TokenScope[] };
}

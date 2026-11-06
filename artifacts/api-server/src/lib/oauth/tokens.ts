import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db, oauthClientsTable, oauthCodesTable, oauthGrantsTable, oauthTokensTable, usersTable } from "@workspace/db";
import type { TokenScope } from "../api-tokens";
import { isAllowed } from "../users";
import { sha256Hex } from "./authorize";
import { sameApiResource, sameResource } from "./config";
import { OAuthError } from "./errors";
import { ensurePluginClientRow, PLUGIN_SCOPES, pluginClient, pluginClients, pluginSecretMatches } from "./plugins";

export const ACCESS_TTL_MS = 3600 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
/** Finestra in cui il riuso di un `car_` è un ritentativo (risposta persa), non un furto. */
export const REFRESH_REUSE_GRACE_MS = 60 * 1000;
const LAST_USED_STEP_MS = 60 * 1000;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: 3600;
  refresh_token: string;
  scope: string;
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

function checkResource(form: Record<string, unknown>, plugin: boolean): void {
  if (form["resource"] !== undefined && !(plugin ? sameApiResource(form["resource"]) : sameResource(form["resource"]))) {
    throw new OAuthError("invalid_target", "risorsa non valida");
  }
}

const invalidClient = () => new OAuthError("invalid_client", "applicazione non riconosciuta", 401);

/**
 * Autentica il client al token endpoint. Un plugin configurato vuole `client_secret` (solo `client_secret_post`): il
 * controllo avviene prima di leggere codice o token di rinnovo, così un segreto sbagliato non consuma né revoca nulla.
 * Un plugin non più configurato è sconosciuto; per i client pubblici un `client_secret` si ignora.
 */
async function authenticateClient(form: Record<string, unknown>, clientId: string): Promise<{ id: number; plugin: boolean }> {
  const configured = pluginClient(clientId);
  if (configured) {
    const secret = str(form["client_secret"]);
    if (secret === undefined || !pluginSecretMatches(configured, secret)) throw invalidClient();
    const row = await ensurePluginClientRow(configured);
    return { id: row.id, plugin: true };
  }
  const [row] = await db
    .select({ id: oauthClientsTable.id, kind: oauthClientsTable.kind })
    .from(oauthClientsTable)
    .where(eq(oauthClientsTable.clientId, clientId));
  if (!row || row.kind === "plugin") throw invalidClient();
  return { id: row.id, plugin: false };
}

type TokenTx = Pick<typeof db, "insert">;

/** Inserisce la coppia di token (solo gli hash nel DB) e restituisce la risposta con i valori in chiaro. */
async function issuePair(tx: TokenTx, grantId: number, plugin: boolean): Promise<TokenResponse> {
  const access = `${plugin ? "cap_" : "cao_"}${randomBytes(32).toString("base64url")}`;
  const refresh = `car_${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  await tx.insert(oauthTokensTable).values([
    { tokenHash: sha256Hex(access), grantId, kind: "access", expiresAt: new Date(now + ACCESS_TTL_MS) },
    { tokenHash: sha256Hex(refresh), grantId, kind: "refresh", expiresAt: new Date(now + REFRESH_TTL_MS) },
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: plugin ? PLUGIN_SCOPES.join(" ") : "mcp" };
}

/** Scambio del codice d'autorizzazione (PKCE S256, client pubblico). */
export async function exchangeCode(form: Record<string, unknown>): Promise<TokenResponse> {
  const code = required(form, "code");
  const redirectUri = required(form, "redirect_uri");
  const clientId = required(form, "client_id");
  const verifier = required(form, "code_verifier");
  if (!VERIFIER_RE.test(verifier)) throw new OAuthError("invalid_request", "code_verifier non valido");
  const client = await authenticateClient(form, clientId);
  checkResource(form, client.plugin);
  const clientRowId = client.id;

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
    return issuePair(tx, row.grantId, client.plugin);
  });
  if (!out) throw invalidGrant();
  return out;
}

async function revokeGrantAndFail(grantId: number): Promise<never> {
  await db.transaction(async (tx) => {
    await tx
      .update(oauthGrantsTable)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthGrantsTable.id, grantId), isNull(oauthGrantsTable.revokedAt)));
  });
  throw invalidGrant();
}

/** Riuso di un `car_` già usato: entro la finestra di tolleranza è un ritentativo (nessuna revoca), oltre è un furto. */
async function handleReuse(grantId: number, usedAt: Date): Promise<never> {
  if (usedAt.getTime() >= Date.now() - REFRESH_REUSE_GRACE_MS) throw invalidGrant();
  return revokeGrantAndFail(grantId);
}

/**
 * Perso l'UPDATE condizionato del rinnovo: si rilegge la riga. Scaduto e mai usato, oppure usato da meno di 60 s
 * (due richieste quasi insieme): `invalid_grant` senza revoca; usato prima della finestra: revoca.
 */
export async function resolveLostRefresh(tokenId: number, grantId: number): Promise<never> {
  const [again] = await db
    .select({ usedAt: oauthTokensTable.usedAt })
    .from(oauthTokensTable)
    .where(eq(oauthTokensTable.id, tokenId));
  if (!again || again.usedAt === null) throw invalidGrant();
  return handleReuse(grantId, again.usedAt);
}

/** Rinnovo con rotazione: un token di rinnovo già usato da più di 60 s revoca l'intero collegamento. */
export async function refreshTokens(form: Record<string, unknown>): Promise<TokenResponse> {
  const refresh = required(form, "refresh_token");
  const clientId = required(form, "client_id");
  const client = await authenticateClient(form, clientId);
  const clientRowId = client.id;

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

  if (row.usedAt !== null) return handleReuse(row.grantId, row.usedAt); // riuso: tolleranza o probabile furto
  if (row.expiresAt.getTime() <= Date.now() || !isAllowed([row.email])) throw invalidGrant();

  const out = await db.transaction(async (tx) => {
    const won = await tx
      .update(oauthTokensTable)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthTokensTable.id, row.id), isNull(oauthTokensTable.usedAt), gt(oauthTokensTable.expiresAt, new Date())))
      .returning({ id: oauthTokensTable.id });
    if (won.length === 0) return null;
    return issuePair(tx, row.grantId, client.plugin);
  });
  // Perso la corsa: si rilegge la riga per capire perché
  if (!out) return resolveLostRefresh(row.id, row.grantId);
  return out;
}

type Verified = { userId: number; grantId: number; scopes: TokenScope[] };

/** Verifica comune: prefisso, token non scaduto, collegamento non revocato, utente ammesso e client del tipo atteso. */
async function verifyToken(raw: string, prefix: string, plugin: boolean): Promise<Verified | null> {
  if (!raw.startsWith(prefix)) return null;
  const [row] = await db
    .select({
      grantId: oauthGrantsTable.id,
      userId: oauthGrantsTable.userId,
      scopes: oauthGrantsTable.scopes,
      lastUsedAt: oauthGrantsTable.lastUsedAt,
      email: usersTable.email,
      clientId: oauthClientsTable.clientId,
      clientKind: oauthClientsTable.kind,
    })
    .from(oauthTokensTable)
    .innerJoin(oauthGrantsTable, eq(oauthGrantsTable.id, oauthTokensTable.grantId))
    .innerJoin(oauthClientsTable, eq(oauthClientsTable.id, oauthGrantsTable.clientRowId))
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
  if (plugin) {
    if (row.clientKind !== "plugin" || !pluginClients().some((c) => c.clientId === row.clientId)) return null;
  } else if (row.clientKind === "plugin") {
    return null;
  }

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

/** Verifica un token d'accesso `cao_…` del connettore: null se sconosciuto, scaduto, revocato, di un plugin o utente non più ammesso. */
export function verifyAccessToken(raw: string): Promise<Verified | null> {
  return verifyToken(raw, "cao_", false);
}

/** Verifica un token d'accesso `cap_…` di un plugin ancora configurato. */
export function verifyPluginAccessToken(raw: string): Promise<Verified | null> {
  return verifyToken(raw, "cap_", true);
}

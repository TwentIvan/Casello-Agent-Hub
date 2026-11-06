import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, oauthCodesTable, oauthGrantsTable } from "@workspace/db";
import { pluginScopeAllowed, sameApiResource, sameResource, scopeAllowed } from "./config";
import { PLUGIN_SCOPES, pluginClient } from "./plugins";
import { redirectMatches, resolveClient } from "./clients";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CONNECTOR_SCOPES = ["mcp", "api:write"];
const MAX_STATE = 500;
const CHALLENGE_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export type AuthorizeParams = {
  clientId: string;
  clientRowId: number;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  kind: "connector" | "plugin";
};

/** Client sconosciuto o ritorno non valido: si mostra una pagina, mai un redirect. */
export class AuthorizePageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizePageError";
  }
}

/** Errore da riportare al client sul suo indirizzo di ritorno (già verificato). */
export class AuthorizeRedirectError extends Error {
  constructor(
    public readonly code: string,
    public readonly redirectUri: string,
    public readonly state: string | null,
  ) {
    super(code);
    this.name = "AuthorizeRedirectError";
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** URL di ritorno con i parametri dati; quelli null si omettono. */
export function buildRedirect(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.toString();
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Valida la richiesta di autorizzazione (query): client e ritorno prima, poi gli altri parametri. */
export async function validateAuthorizeRequest(query: Record<string, unknown>): Promise<AuthorizeParams> {
  const clientId = str(query["client_id"]);
  const redirectUri = str(query["redirect_uri"]);
  if (!clientId) throw new AuthorizePageError("Applicazione non riconosciuta.");
  const client = await resolveClient(clientId);
  if (!client) throw new AuthorizePageError("Applicazione non riconosciuta.");
  const plugin = client.kind === "plugin" ? pluginClient(clientId) : null;
  const redirectOk = plugin
    ? redirectUri === plugin.redirectUri
    : !!redirectUri && redirectMatches(client.redirectUris, redirectUri);
  if (!redirectUri || !redirectOk) {
    throw new AuthorizePageError("Indirizzo di ritorno non valido.");
  }

  const rawState = str(query["state"]);
  const state = rawState !== undefined && rawState.length <= MAX_STATE ? rawState : null;
  const fail = (code: string): never => {
    throw new AuthorizeRedirectError(code, redirectUri, state);
  };

  if (rawState !== undefined && rawState.length > MAX_STATE) fail("invalid_request");
  if (str(query["response_type"]) !== "code") fail("unsupported_response_type");
  const scope = query["scope"];
  if (scope !== undefined && !(plugin ? pluginScopeAllowed(scope) : scopeAllowed(scope))) fail("invalid_scope");
  const resource = query["resource"];
  if (resource !== undefined && !(plugin ? sameApiResource(resource) : sameResource(resource))) fail("invalid_target");
  const challenge = str(query["code_challenge"]);
  if (!challenge || !CHALLENGE_RE.test(challenge)) fail("invalid_request");
  if (query["code_challenge_method"] !== "S256") fail("invalid_request");

  return {
    clientId: client.clientId,
    clientRowId: client.id,
    clientName: client.name,
    redirectUri,
    codeChallenge: challenge!,
    state,
    kind: plugin ? "plugin" : "connector",
  };
}

/**
 * Consenso: in una sola transazione revoca il collegamento attivo dello stesso utente e client, crea il nuovo
 * e il codice d'autorizzazione (solo l'hash nel DB). Restituisce l'URL di ritorno con `code` e `state`.
 */
export async function approve(userId: number, p: AuthorizeParams): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx
      .update(oauthGrantsTable)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthGrantsTable.userId, userId), eq(oauthGrantsTable.clientRowId, p.clientRowId), isNull(oauthGrantsTable.revokedAt)));
    const [grant] = await tx
      .insert(oauthGrantsTable)
      .values({ userId, clientRowId: p.clientRowId, scopes: p.kind === "plugin" ? [...PLUGIN_SCOPES] : CONNECTOR_SCOPES })
      .returning({ id: oauthGrantsTable.id });
    await tx.insert(oauthCodesTable).values({
      codeHash: sha256Hex(code),
      grantId: grant!.id,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
  });
  return buildRedirect(p.redirectUri, { code, state: p.state });
}

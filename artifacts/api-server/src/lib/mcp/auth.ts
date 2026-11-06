// Autenticazione del server MCP: `Authorization: Bearer cas_…` (token personale). Niente cookie di
// sessione su /mcp. Mai nei log il token, il suo hash o l'header Authorization.

import type { RequestHandler } from "express";
import { authenticateApiToken, bearerToken, type TokenScope } from "../api-tokens";
import { logger } from "../logger";
import { oauthBase } from "../oauth/config";
import { verifyAccessToken } from "../oauth/tokens";

export const MCP_UNAUTHORIZED = "token non valido o scaduto";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Utente autenticato dal token personale (solo sulle richieste a /mcp). */
      mcpUserId?: number;
      /** Ambiti del token (solo sulle richieste a /mcp): `approva`/`rifiuta` vogliono anche `api:write`. */
      mcpScopes?: TokenScope[];
    }
  }
}

function unauthorized(res: Parameters<RequestHandler>[1]): void {
  // Indica al client dove trovare i metadati OAuth (RFC 9728): avvia il flusso del connettore.
  res
    .status(401)
    .set("WWW-Authenticate", `Bearer resource_metadata="${oauthBase().issuer}/.well-known/oauth-protected-resource"`)
    .json({ error: MCP_UNAUTHORIZED });
}

/**
 * Richiede un token valido per /mcp: personale `cas_…` con l'ambito mcp, oppure d'accesso `cao_…` del connettore OAuth
 * (ambiti mcp e api:write); altrimenti 401 con il messaggio fisso e l'indicazione dei metadati OAuth.
 */
export function requireApiToken(): RequestHandler {
  return (req, res, next) => {
    const token = bearerToken(req);
    if (!token) {
      unauthorized(res);
      return;
    }
    const verify = token.startsWith("cao_")
      ? verifyAccessToken(token).then((a) => (a && a.scopes.includes("mcp") ? { userId: a.userId, scopes: a.scopes } : null))
      : authenticateApiToken(token).then((a) => (a && a.nodeId === null && a.scopes.includes("mcp") ? { userId: a.userId, scopes: a.scopes } : null));
    verify
      .then((auth) => {
        if (!auth) {
          unauthorized(res);
          return;
        }
        req.mcpUserId = auth.userId;
        req.mcpScopes = auth.scopes;
        next();
      })
      .catch((err: unknown) => {
        logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Verifica del token MCP non riuscita");
        res.status(500).json({ error: "errore interno" });
      });
  };
}

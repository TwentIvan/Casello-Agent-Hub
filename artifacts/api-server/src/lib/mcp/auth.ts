// Autenticazione del server MCP: `Authorization: Bearer cas_…` (token personale). Niente cookie di
// sessione su /mcp. Mai nei log il token, il suo hash o l'header Authorization.

import type { RequestHandler } from "express";
import { authenticateApiToken, bearerToken } from "../api-tokens";
import { logger } from "../logger";

export const MCP_UNAUTHORIZED = "token non valido o scaduto";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Utente autenticato dal token personale (solo sulle richieste a /mcp). */
      mcpUserId?: number;
    }
  }
}

/** Richiede un token personale valido con l'ambito mcp; altrimenti 401 con il messaggio fisso. */
export function requireApiToken(): RequestHandler {
  return (req, res, next) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: MCP_UNAUTHORIZED });
      return;
    }
    authenticateApiToken(token)
      .then((auth) => {
        if (!auth || !auth.scopes.includes("mcp")) {
          res.status(401).json({ error: MCP_UNAUTHORIZED });
          return;
        }
        req.mcpUserId = auth.userId;
        next();
      })
      .catch((err: unknown) => {
        logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Verifica del token MCP non riuscita");
        res.status(500).json({ error: "errore interno" });
      });
  };
}

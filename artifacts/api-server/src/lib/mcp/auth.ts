// Autenticazione del server MCP: `Authorization: Bearer cas_…` (token personale). Niente cookie di
// sessione su /mcp. Mai nei log il token, il suo hash o l'header Authorization.

import type { Request, RequestHandler } from "express";
import { authenticateApiToken } from "../api-tokens";
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

/** Token dall'header `Authorization: Bearer <token>` (schema senza badare alle maiuscole), o null. */
function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1]! : null;
}

/** Richiede un token personale valido; altrimenti 401 con il messaggio fisso. */
export function requireApiToken(): RequestHandler {
  return (req, res, next) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: MCP_UNAUTHORIZED });
      return;
    }
    authenticateApiToken(token)
      .then((auth) => {
        if (!auth) {
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

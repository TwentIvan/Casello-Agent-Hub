// Autenticazione del protocollo dei nodi (/api/node/*): solo un token d'ambito `node` di un nodo attivo.
// La sessione e i token personali sono rifiutati (403); mai nei log token, hash o header Authorization.

import type { Request, RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { db, nodesTable } from "@workspace/db";
import { TOKEN_MESSAGES, authenticateApiToken, bearerToken } from "../api-tokens";
import { logger } from "../logger";

export const NODE_AUTH_MESSAGES = {
  disabled: "nodo disattivato",
} as const;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Nodo autenticato dal token (solo sulle richieste a /api/node). */
      node?: { id: number; userId: number };
    }
  }
}

/** Id del nodo della richiesta impostato da requireNodeToken; lancia se la route non è protetta. */
export function currentNode(req: Request): { id: number; userId: number } {
  if (!req.node) throw new Error("req.node assente: la route non passa da requireNodeToken");
  return req.node;
}

export const requireNodeToken: RequestHandler = async (req, res, next) => {
  try {
    // Senza header (sessione) non c'è un token di nodo: 403, non 401
    if (req.headers.authorization === undefined) {
      res.status(403).json({ error: TOKEN_MESSAGES.scope });
      return;
    }
    const raw = bearerToken(req);
    let found: Awaited<ReturnType<typeof authenticateApiToken>>;
    try {
      found = raw === null ? null : await authenticateApiToken(raw);
    } catch (err) {
      logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Verifica del token del nodo non riuscita");
      res.status(500).json({ error: "errore interno" });
      return;
    }
    if (!found) {
      res.status(401).json({ error: TOKEN_MESSAGES.invalid });
      return;
    }
    if (found.nodeId === null || !found.scopes.includes("node")) {
      res.status(403).json({ error: TOKEN_MESSAGES.scope });
      return;
    }
    const [node] = await db.select().from(nodesTable).where(eq(nodesTable.id, found.nodeId));
    if (!node || node.status !== "active") {
      res.status(403).json({ error: NODE_AUTH_MESSAGES.disabled });
      return;
    }
    req.userId = found.userId;
    req.node = { id: node.id, userId: node.userId };
    // I limiti (heartbeat, claim, ping) sono per nodo e stanno nelle singole route
    next();
  } catch (err) {
    next(err);
  }
};

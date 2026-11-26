// Autenticazione del protocollo del runner (/api/collaudo/*, tranne il claim): `Bearer ctk_…` di un collaudo `running`
// con il token non scaduto. Mai nei log token, hash o header Authorization.

import type { Request, RequestHandler } from "express";
import { and, eq, gt } from "drizzle-orm";
import { db, releaseTestsTable } from "@workspace/db";
import { bearerToken } from "../api-tokens";
import { logger } from "../logger";
import { COLLAUDO_TOKEN_PREFIX, hashSecret } from "./tokens";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Collaudo autenticato dal token (solo sulle richieste a /api/collaudo). */
      collaudo?: { testId: number };
    }
  }
}

const INVALID = "token non valido o scaduto";

export function currentCollaudo(req: Request): { testId: number } {
  if (!req.collaudo) throw new Error("req.collaudo assente: la route non passa da requireCollaudoToken");
  return req.collaudo;
}

export const requireCollaudoToken: RequestHandler = async (req, res, next) => {
  try {
    const raw = bearerToken(req);
    if (raw === null || !raw.startsWith(COLLAUDO_TOKEN_PREFIX)) {
      res.status(401).json({ error: INVALID });
      return;
    }
    let row: { id: number } | undefined;
    try {
      [row] = await db
        .select({ id: releaseTestsTable.id })
        .from(releaseTestsTable)
        .where(
          and(
            eq(releaseTestsTable.tokenHash, hashSecret(raw)),
            eq(releaseTestsTable.status, "running"),
            gt(releaseTestsTable.tokenExpiresAt, new Date()),
          ),
        );
    } catch (err) {
      logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Verifica del token di collaudo non riuscita");
      res.status(500).json({ error: "errore interno" });
      return;
    }
    if (!row) {
      res.status(401).json({ error: INVALID });
      return;
    }
    req.collaudo = { testId: row.id };
    next();
  } catch (err) {
    next(err);
  }
};

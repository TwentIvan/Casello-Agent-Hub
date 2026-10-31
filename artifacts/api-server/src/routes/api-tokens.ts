import { Router, type IRouter } from "express";
import type { ApiToken } from "@workspace/db";
import {
  CreateApiTokenBody,
  CreateApiTokenResponse,
  ListApiTokensResponse,
  RevokeApiTokenParams,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { ApiTokenInputError, type TokenScope, createApiToken, listApiTokens, revokeApiToken } from "../lib/api-tokens";
import { parseRequest } from "../middlewares/error-handler";

// Token personali dell'utente (server MCP e /api). Il valore compare solo nella risposta di
// creazione; mai l'hash. Un token di un altro utente è come se non esistesse (404). Si gestiscono
// solo con il login: un token non può crearne né revocarne altri.

const TOKEN_NOT_FOUND = "token non trovato";

function toInfo(row: ApiToken) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    scopes: row.scopes as TokenScope[],
  };
}

export function createApiTokensRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/account/tokens", sessionOnly, async (req, res) => {
    const rows = await listApiTokens(currentUserId(req));
    res.json(ListApiTokensResponse.parse(rows.map(toInfo)));
  });

  router.post("/account/tokens", sessionOnly, async (req, res) => {
    const body = parseRequest(CreateApiTokenBody, req.body);
    try {
      const { token, row } = await createApiToken(currentUserId(req), body.name, body.expiresInDays, body.scopes);
      res.status(201).json(CreateApiTokenResponse.parse({ token, info: toInfo(row) }));
    } catch (err) {
      if (err instanceof ApiTokenInputError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.delete("/account/tokens/:id", sessionOnly, async (req, res) => {
    const { id } = parseRequest(RevokeApiTokenParams, req.params);
    if (!(await revokeApiToken(currentUserId(req), id))) {
      res.status(404).json({ error: TOKEN_NOT_FOUND });
      return;
    }
    res.status(204).end();
  });

  return router;
}

export default createApiTokensRouter;

import { Router, type ErrorRequestHandler, type IRouter } from "express";
import { authorizationServerMetadata, protectedResourceMetadata } from "../lib/oauth/metadata";
import { registerClient } from "../lib/oauth/clients";
import { OAuthError } from "../lib/oauth/errors";
import { logger } from "../lib/logger";
import { oauthRegisterRateLimit } from "../middlewares/rate-limit";

/**
 * Errori su /oauth/*, anche quelli dei parser globali (che girano prima del router): sempre JSON OAuth.
 * Montato in app.ts subito dopo il router.
 */
export const oauthErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof OAuthError) {
    res.status(err.status).json(err.toJSON());
    return;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const tooBig = status === 413;
    res
      .status(tooBig ? 413 : 400)
      .json(new OAuthError("invalid_request", tooBig ? "corpo della richiesta troppo grande" : "richiesta non valida").toJSON());
    return;
  }
  logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Errore nelle route OAuth");
  res.status(500).json(new OAuthError("server_error", "errore interno", 500).toJSON());
};

/** Route OAuth del connettore, alla radice dell'app (fuori da /api). */
export function oauthRouter(): IRouter {
  const r = Router();

  r.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    res.json(protectedResourceMetadata());
  });
  r.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(authorizationServerMetadata());
  });

  r.post("/oauth/register", oauthRegisterRateLimit, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const out = await registerClient(req.body);
      res.status(out.status).json(out.body);
    } catch (err) {
      if (err instanceof OAuthError) {
        res.status(err.status).json(err.toJSON());
        return;
      }
      throw err;
    }
  });

  return r;
}

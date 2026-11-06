import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type ErrorRequestHandler, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { sessionUserId } from "../lib/auth";
import {
  AuthorizePageError,
  AuthorizeRedirectError,
  approve,
  buildRedirect,
  validateAuthorizeRequest,
} from "../lib/oauth/authorize";
import { consentPage, errorPage, sendPage } from "../lib/oauth/pages";
import { authorizationServerMetadata, protectedResourceMetadata } from "../lib/oauth/metadata";
import { registerClient } from "../lib/oauth/clients";
import { pluginClient } from "../lib/oauth/plugins";
import { OAuthError } from "../lib/oauth/errors";
import { exchangeCode, refreshTokens } from "../lib/oauth/tokens";
import { logger } from "../lib/logger";
import { isUniqueViolation } from "../lib/pg-errors";
import { oauthAuthorizeRateLimit, oauthRegisterDailyRateLimit, oauthRegisterRateLimit, oauthTokenRateLimit } from "../middlewares/rate-limit";

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

const EXPIRED_MESSAGE = "Richiesta scaduta: ricomincia dall'app Claude";

/** Errore inatteso su /oauth/authorize: pagina d'errore (mai JSON), senza dettagli. */
function sendInternalError(res: Response, err: unknown): void {
  logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Errore su /oauth/authorize");
  if (res.headersSent) return;
  sendPage(res, 500, errorPage("Errore interno: riprova tra poco"));
}

function sameToken(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

/** Errori di validazione: pagina (client o ritorno non validi) o redirect con `error`. Altri errori: false. */
function handleAuthorizeError(err: unknown, res: Response): boolean {
  if (err instanceof AuthorizePageError) {
    sendPage(res, 400, errorPage(err.message));
    return true;
  }
  if (err instanceof AuthorizeRedirectError) {
    res.redirect(buildRedirect(err.redirectUri, { error: err.code, state: err.state }));
    return true;
  }
  return false;
}

/** Route OAuth del connettore, alla radice dell'app (fuori da /api). */
export function oauthRouter(): IRouter {
  const r = Router();

  r.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    res.json(protectedResourceMetadata());
  });
  r.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(authorizationServerMetadata());
  });

  r.post("/oauth/register", oauthRegisterRateLimit, oauthRegisterDailyRateLimit, async (req, res) => {
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

  r.get("/oauth/authorize", oauthAuthorizeRateLimit, async (req, res) => {
    try {
      const params = await validateAuthorizeRequest(req.query as Record<string, unknown>);
      const userId = await sessionUserId(req);
      if (userId === null) {
        res.redirect(`/api/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
        return;
      }
      const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId));
      const csrf = randomBytes(32).toString("base64url");
      req.session.oauthPending = { params, csrf };
      await saveSession(req);
      sendPage(res, 200, consentPage({ clientName: params.clientName, redirectHost: new URL(params.redirectUri).host, userEmail: user?.email ?? "", csrf, kind: params.kind }));
    } catch (err) {
      if (!handleAuthorizeError(err, res)) sendInternalError(res, err);
    }
  });

  r.post("/oauth/authorize", oauthAuthorizeRateLimit, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const pending = req.session.oauthPending;
      const userId = await sessionUserId(req);
      if (userId === null || !pending || !sameToken(body["csrf"], pending.csrf)) {
        sendPage(res, 400, errorPage(EXPIRED_MESSAGE));
        return;
      }
      const decision = body["decision"];
      if (decision !== "allow" && decision !== "deny") {
        sendPage(res, 400, errorPage("Richiesta non valida."));
        return;
      }
      // La richiesta si usa una volta sola
      delete req.session.oauthPending;
      await saveSession(req);
      const { params } = pending;
      if (decision === "deny") {
        res.redirect(buildRedirect(params.redirectUri, { error: "access_denied", state: params.state }));
        return;
      }
      // Un plugin tolto dalla configurazione dopo la pagina di consenso non ottiene né collegamento né codice
      if (params.kind === "plugin" && !pluginClient(params.clientId)) {
        sendPage(res, 400, errorPage("Applicazione non riconosciuta."));
        return;
      }
      try {
        res.redirect(await approve(userId, params));
      } catch (err) {
        // Due consensi insieme per lo stesso client e utente: l'indice unico lascia passare solo il primo
        if (!isUniqueViolation(err)) throw err;
        sendPage(res, 400, errorPage(EXPIRED_MESSAGE));
      }
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  r.post("/oauth/token", oauthTokenRateLimit, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    const form = (req.body ?? {}) as Record<string, unknown>;
    const grantType = form["grant_type"];
    if (typeof grantType !== "string") throw new OAuthError("invalid_request", "parametro mancante: grant_type");
    if (grantType === "authorization_code") res.json(await exchangeCode(form));
    else if (grantType === "refresh_token") res.json(await refreshTokens(form));
    else throw new OAuthError("unsupported_grant_type", "grant_type non supportato");
  });

  return r;
}

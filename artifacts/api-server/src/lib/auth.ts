// Autenticazione: login Google (OIDC, authorization code + PKCE), sessione su Postgres con cookie
// httpOnly e middleware che protegge /api. Accedono solo gli indirizzi in ALLOWED_EMAILS.

import { Router, type IRouter, type RequestHandler } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import * as oidc from "openid-client";
import { pool } from "@workspace/db";
import { logger } from "./logger";

export interface SessionUser {
  email: string;
  name: string | null;
  picture: string | null;
}

declare module "express-session" {
  interface SessionData {
    user?: SessionUser;
    oidc?: { state: string; nonce: string; codeVerifier: string; returnTo: string };
  }
}

const isProduction = process.env.NODE_ENV === "production";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEV_USER: SessionUser = { email: "dev@localhost", name: "Sviluppo locale", picture: null };

// Solo per lo sviluppo locale senza credenziali Google: mai in produzione.
const authDisabled = process.env.AUTH_DISABLED === "true";
if (authDisabled && isProduction) {
  throw new Error("AUTH_DISABLED=true non è ammesso con NODE_ENV=production.");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} è obbligatoria per il login (oppure, solo in sviluppo, AUTH_DISABLED=true).`);
  }
  return value;
}

interface AuthConfig {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  publicAppUrl: string;
  allowedEmails: Set<string>;
  sessionSecret: string;
}

function loadConfig(): AuthConfig | null {
  if (authDisabled) {
    logger.warn("AUTH_DISABLED=true: /api è accessibile senza login (solo sviluppo).");
    return null;
  }
  const publicAppUrl = requireEnv("PUBLIC_APP_URL").replace(/\/$/, "");
  const allowedEmails = new Set(
    (process.env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowedEmails.size === 0) {
    logger.warn("ALLOWED_EMAILS è vuota: nessuno potrà accedere.");
  }
  return {
    issuer: new URL(process.env.OIDC_ISSUER ?? "https://accounts.google.com"),
    clientId: requireEnv("GOOGLE_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
    redirectUri: `${publicAppUrl}/api/auth/callback`,
    publicAppUrl,
    allowedEmails,
    sessionSecret: requireEnv("SESSION_SECRET"),
  };
}

// Letta all'avvio: in produzione una configurazione mancante blocca il server invece di lasciarlo aperto.
const config = loadConfig();

let discovered: Promise<oidc.Configuration> | null = null;

function getOidcConfiguration(cfg: AuthConfig): Promise<oidc.Configuration> {
  // Discovery pigra e in cache; se fallisce si riprova alla richiesta successiva.
  discovered ??= oidc
    .discovery(
      cfg.issuer,
      cfg.clientId,
      cfg.clientSecret,
      undefined,
      // Un issuer http (provider finto nei test locali) è accettato solo fuori produzione.
      cfg.issuer.protocol === "http:" && !isProduction ? { execute: [oidc.allowInsecureRequests] } : undefined,
    )
    .catch((err: unknown) => {
      discovered = null;
      throw err;
    });
  return discovered;
}

/** Accetta solo percorsi interni ("/runs/3"), mai URL esterni o "//host". */
function safeReturnTo(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function sessionMiddleware(): RequestHandler {
  const PgStore = connectPgSimple(session);
  return session({
    name: "casello.sid",
    store: new PgStore({ pool, tableName: "sessions" }),
    secret: config?.sessionSecret ?? "sviluppo-senza-login",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: SESSION_TTL_MS },
  });
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (authDisabled || req.session.user) {
    next();
    return;
  }
  res.status(401).json({ error: "Login richiesto" });
};

export function authRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/auth/me", (req, res) => {
    const user = authDisabled ? DEV_USER : req.session.user;
    if (!user) {
      res.status(401).json({ error: "Login richiesto" });
      return;
    }
    res.json(user);
  });

  router.post("/auth/logout", (req, res, next) => {
    req.session.destroy((err) => {
      if (err) {
        next(err);
        return;
      }
      res.clearCookie("casello.sid");
      res.status(204).end();
    });
  });

  if (!config) return router;
  const cfg = config;

  router.get("/auth/login", async (req, res, next) => {
    try {
      const oidcConfig = await getOidcConfiguration(cfg);
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      req.session.oidc = { state, nonce, codeVerifier, returnTo: safeReturnTo(req.query.returnTo) };

      const url = oidc.buildAuthorizationUrl(oidcConfig, {
        redirect_uri: cfg.redirectUri,
        scope: "openid email profile",
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: "S256",
        state,
        nonce,
        prompt: "select_account",
      });
      req.session.save((err) => (err ? next(err) : res.redirect(url.href)));
    } catch (err) {
      next(err);
    }
  });

  router.get("/auth/callback", async (req, res) => {
    const pending = req.session.oidc;
    delete req.session.oidc;
    if (!pending) {
      res.redirect("/?auth=error");
      return;
    }
    try {
      const oidcConfig = await getOidcConfiguration(cfg);
      const currentUrl = new URL(req.originalUrl, cfg.publicAppUrl);
      const tokens = await oidc.authorizationCodeGrant(oidcConfig, currentUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : null;

      if (!email || claims?.email_verified !== true || !cfg.allowedEmails.has(email)) {
        logger.warn({ email }, "Login rifiutato: account non autorizzato");
        res.redirect("/?auth=denied");
        return;
      }

      const user: SessionUser = {
        email,
        name: typeof claims?.name === "string" ? claims.name : null,
        picture: typeof claims?.picture === "string" ? claims.picture : null,
      };
      // Nuovo id di sessione al login (contro la session fixation).
      req.session.regenerate((err) => {
        if (err) {
          logger.error({ err }, "Rigenerazione della sessione fallita");
          res.redirect("/?auth=error");
          return;
        }
        req.session.user = user;
        req.session.save(() => res.redirect(pending.returnTo));
      });
    } catch (err) {
      logger.error({ err }, "Callback OIDC fallita");
      res.redirect("/?auth=error");
    }
  });

  return router;
}

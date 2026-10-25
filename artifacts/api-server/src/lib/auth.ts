// Autenticazione: login Google (OIDC, authorization code + PKCE), sessione su Postgres con cookie
// httpOnly e middleware che protegge /api. Chi entra lo decide isAllowed (users.ts); la sessione porta
// l'id dell'utente (userId) più i dati da mostrare.

import { Router, type IRouter, type Request, type RequestHandler } from "express";
import session, { type SessionData } from "express-session";
import connectPgSimple from "connect-pg-simple";
import * as oidc from "openid-client";
import { eq } from "drizzle-orm";
import { db, pool, usersTable } from "@workspace/db";
import { GetCurrentUserResponse } from "@workspace/api-zod";
import { logger } from "./logger";
import { IdentityConflictError, ensureUserByEmail, isAllowed, listIdentities, resolveLogin } from "./users";

export interface SessionUser {
  email: string;
  name: string | null;
  picture: string | null;
}

declare module "express-session" {
  interface SessionData {
    /** Utente di Casello. Manca nelle sessioni della fase 1: si ricava da user.email alla prima richiesta. */
    userId?: number;
    /** Dati da mostrare (email, nome, foto). */
    user?: SessionUser;
    oidc?: { state: string; nonce: string; codeVerifier: string; returnTo: string };
    /** Login o collegamento GitHub in corso (state e PKCE). */
    github?: { state: string; codeVerifier: string; mode: "login" | "link"; returnTo: string };
  }
}

// Il Request di express-serve-static-core estende Express.Request: si aumenta questo, perché il
// pacchetto dei tipi non è una dipendenza diretta dell'API (pnpm non lo rende risolvibile)
declare global {
  namespace Express {
    interface Request {
      /** Impostato da requireAuth. */
      userId?: number;
    }
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
  sessionSecret: string;
}

function loadConfig(): AuthConfig | null {
  if (authDisabled) {
    logger.warn("AUTH_DISABLED=true: /api è accessibile senza login (solo sviluppo).");
    return null;
  }
  const publicAppUrl = requireEnv("PUBLIC_APP_URL").replace(/\/$/, "");
  // isAllowed rilegge ALLOWED_EMAILS a ogni login: qui solo l'avviso all'avvio
  if (!(process.env.ALLOWED_EMAILS ?? "").split(",").some((email) => email.trim())) {
    logger.warn("ALLOWED_EMAILS è vuota: nessuno potrà accedere.");
  }
  return {
    issuer: new URL(process.env.OIDC_ISSUER ?? "https://accounts.google.com"),
    clientId: requireEnv("GOOGLE_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
    redirectUri: `${publicAppUrl}/api/auth/callback`,
    publicAppUrl,
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

/**
 * Id dell'utente della sessione. Una sessione della fase 1 (solo user.email) viene convertita: si
 * trova o crea l'utente da quell'email e si scrive userId nella sessione. Null senza utente.
 */
export async function resolveSessionUserId(session: Partial<Pick<SessionData, "userId" | "user">>): Promise<number | null> {
  if (session.userId !== undefined) return session.userId;
  const legacy = session.user;
  if (!legacy?.email) return null;
  const user = await ensureUserByEmail(legacy.email, legacy.name, legacy.picture);
  session.userId = user.id;
  return user.id;
}

/**
 * Utente di sviluppo (AUTH_DISABLED), creato al bisogno. Nessuna cache: i test svuotano le tabelle e
 * un id in memoria potrebbe puntare a una riga sparita; in sviluppo una query in più non pesa.
 */
async function devUserId(): Promise<number> {
  return (await ensureUserByEmail(DEV_USER.email, DEV_USER.name, DEV_USER.picture)).id;
}

/** Protegge /api (o una singola route): imposta req.userId oppure risponde 401. */
export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const userId = authDisabled ? await devUserId() : await resolveSessionUserId(req.session);
    if (userId === null) {
      res.status(401).json({ error: "Login richiesto" });
      return;
    }
    req.userId = userId;
    next();
  } catch (err) {
    next(err);
  }
};

/** Id dell'utente impostato da requireAuth; lancia se la route non è protetta. */
export function currentUserId(req: Request): number {
  if (req.userId === undefined) throw new Error("req.userId assente: la route non passa da requireAuth");
  return req.userId;
}

export function authRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/auth/me", async (req, res) => {
    // Anche qui una sessione della fase 1 viene convertita (è la prima richiesta della UI)
    const userId = authDisabled ? await devUserId() : await resolveSessionUserId(req.session);
    const [user] = userId === null ? [] : await db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!user) {
      res.status(401).json({ error: "Login richiesto" });
      return;
    }
    res.json(
      GetCurrentUserResponse.parse({
        email: user.email,
        name: user.name,
        picture: user.picture,
        identities: await listIdentities(user.id),
        // Lo imposta il task 3 (configurazione dell'App GitHub): per ora GitHub è sempre spento
        githubEnabled: false,
      }),
    );
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

      if (!email || claims?.email_verified !== true || !isAllowed([email])) {
        logger.warn({ email }, "Login rifiutato: account non autorizzato");
        res.redirect("/?auth=denied");
        return;
      }

      const name = typeof claims?.name === "string" ? claims.name : null;
      const picture = typeof claims?.picture === "string" ? claims.picture : null;
      // Identità Google → utente (esistente, trovato per email o nuovo)
      const dbUser = await resolveLogin({
        provider: "google",
        providerUserId: claims!.sub,
        emails: [email],
        primaryEmail: email,
        username: null,
        name,
        picture,
      });
      const user: SessionUser = { email: dbUser.email, name: dbUser.name, picture: dbUser.picture };
      // Nuovo id di sessione al login (contro la session fixation).
      req.session.regenerate((err) => {
        if (err) {
          logger.error({ err }, "Rigenerazione della sessione fallita");
          res.redirect("/?auth=error");
          return;
        }
        req.session.userId = dbUser.id;
        req.session.user = user;
        req.session.save(() => res.redirect(pending.returnTo));
      });
    } catch (err) {
      if (err instanceof IdentityConflictError) {
        logger.warn({ reason: err.message }, "Login Google rifiutato: conflitto di identità");
      } else {
        logger.error({ err }, "Callback OIDC fallita");
      }
      res.redirect("/?auth=error");
    }
  });

  return router;
}

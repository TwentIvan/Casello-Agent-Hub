// Login e collegamento con GitHub (OAuth della GitHub App, state + PKCE S256 in sessione), un'unica
// callback che gestisce anche il ritorno dall'installazione dell'App, e scollegamento.
// Il token dell'utente si usa solo dentro la callback: mai in sessione, DB, log o redirect.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { currentUserId, requireAuth, safeReturnTo, sessionOnly, sessionUserId, type SessionUser } from "../auth";
import { logger } from "../logger";
import { IdentityConflictError, isAllowed, linkIdentity, resolveLogin, unlinkIdentity, type LoginIdentity } from "../users";
import { exchangeCode, getGithubUser, getVerifiedEmails, GithubError } from "./app";
import type { GithubConfig } from "./config";
import { syncInstallations } from "./installations";

type Mode = "login" | "link";

/** Confronto a tempo costante (lunghezze diverse → falso subito: la lunghezza dello state non è segreta). */
function sameState(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Aggiunge un parametro a un percorso interno che può avere già una query string. */
function withParam(path: string, name: string, value: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${name}=${encodeURIComponent(value)}`;
}

/** Solo nome e stato HTTP: il messaggio di un errore qualsiasi potrebbe contenere dati. */
function errorSummary(err: unknown): { errName: string; status: number | null } {
  return {
    errName: err instanceof Error ? err.name : typeof err,
    status: err instanceof GithubError ? err.status : null,
  };
}

/**
 * Sincronizza le installazioni senza bloccare login o collegamento: se fallisce si registra solo
 * nome e stato dell'errore; le installazioni si riallineano alla prossima callback valida.
 */
async function syncWithoutBlocking(cfg: GithubConfig, userId: number, token: string): Promise<void> {
  try {
    await syncInstallations(cfg, userId, token);
  } catch (err) {
    logger.warn(errorSummary(err), "Sincronizzazione delle installazioni GitHub fallita");
  }
}

export function githubAuthRouter(cfg: GithubConfig, opts: { publicAppUrl: string }): IRouter {
  const router: IRouter = Router();
  const redirectUri = `${opts.publicAppUrl.replace(/\/+$/, "")}/api/auth/github/callback`;

  /** state e verifier PKCE in sessione, poi redirect alla pagina di autorizzazione di GitHub. */
  function startFlow(mode: Mode) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const state = randomBytes(32).toString("base64url");
      const codeVerifier = randomBytes(32).toString("base64url");
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      req.session.github = { state, codeVerifier, mode, returnTo: safeReturnTo(req.query.returnTo) };

      // Nessuno scope: il token utente di una GitHub App ha i permessi dell'App
      const url = new URL(`${cfg.webBase}/login/oauth/authorize`);
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      req.session.save((err) => (err ? next(err) : res.redirect(url.href)));
    };
  }

  router.get("/auth/github/login", startFlow("login"));
  // Solo con il login: con un token, l'account GitHub che completa il flusso verrebbe collegato
  // all'utente del token e darebbe poi un login completo (da token a sessione)
  router.get("/auth/github/link", requireAuth, sessionOnly, startFlow("link"));

  router.get("/auth/github/callback", async (req, res) => {
    // state monouso: tolto dalla sessione prima di qualsiasi altra cosa
    const pending = req.session.github;
    delete req.session.github;
    const code = req.query.code;

    // L'utente ha annullato su GitHub: nessuno scambio, si torna da dove si era partiti
    if (req.query.error === "access_denied") {
      res.redirect(withParam(pending?.returnTo ?? "/", "github", "cancelled"));
      return;
    }
    // Altri errori di GitHub (es. application_suspended): nessuno scambio; il collegamento torna
    // alla pagina Account, il login alla pagina di accesso
    if (req.query.error !== undefined) {
      res.redirect(pending?.mode === "link" ? "/account?github=error" : "/?auth=error");
      return;
    }

    if (!pending || !sameState(pending.state, req.query.state) || typeof code !== "string" || !code) {
      // Codice senza il nostro state (ritorno dall'installazione, o richiesta forgiata): mai
      // scambiato. Con una sessione Casello si riparte dal collegamento, che GitHub approva subito.
      try {
        if (typeof code === "string" && code && (await sessionUserId(req)) !== null) {
          res.redirect("/api/auth/github/link?returnTo=/account");
          return;
        }
      } catch (err) {
        logger.error(errorSummary(err), "Callback GitHub: lettura della sessione fallita");
      }
      res.redirect("/?auth=error");
      return;
    }

    const failure = pending.mode === "login" ? "/?auth=error" : "/account?github=error";
    try {
      const token = await exchangeCode(cfg, code, pending.codeVerifier);
      const ghUser = await getGithubUser(cfg, token);
      const emails = await getVerifiedEmails(cfg, token);
      const primaryEmail = emails.primary ?? emails.all[0] ?? null;

      if (pending.mode === "login") {
        // Senza email verificata o senza email ammessa non si crea nessun utente
        if (primaryEmail === null || !isAllowed(emails.all)) {
          logger.warn({ githubUserId: ghUser.id }, "Login GitHub rifiutato: email GitHub non autorizzata");
          res.redirect("/?auth=denied&provider=github");
          return;
        }
        const identity = toIdentity(ghUser, emails.all, primaryEmail);
        const dbUser = await resolveLogin(identity);
        await syncWithoutBlocking(cfg, dbUser.id, token);
        const user: SessionUser = { email: dbUser.email, name: dbUser.name, picture: dbUser.picture };
        // Nuovo id di sessione al login (contro la session fixation), come per Google
        req.session.regenerate((err) => {
          if (err) {
            logger.error(errorSummary(err), "Rigenerazione della sessione fallita");
            res.redirect("/?auth=error");
            return;
          }
          req.session.userId = dbUser.id;
          req.session.user = user;
          req.session.save(() => res.redirect(pending.returnTo));
        });
        return;
      }

      // Collegamento: l'utente è quello della sessione che ha avviato il flusso, già dentro
      // (nessun controllo su ALLOWED_EMAILS)
      const userId = await sessionUserId(req);
      if (userId === null) {
        res.redirect("/?auth=error");
        return;
      }
      if (primaryEmail === null) {
        logger.warn({ githubUserId: ghUser.id }, "Collegamento GitHub rifiutato: nessuna email verificata");
        res.redirect(failure);
        return;
      }
      await linkIdentity(userId, toIdentity(ghUser, emails.all, primaryEmail));
      await syncWithoutBlocking(cfg, userId, token);
      res.redirect(pending.returnTo);
    } catch (err) {
      if (err instanceof IdentityConflictError) {
        logger.warn({ reason: err.message, mode: pending.mode }, "GitHub: conflitto di identità");
        res.redirect(pending.mode === "link" ? "/account?github=conflict" : failure);
        return;
      }
      logger.error(errorSummary(err), "Callback GitHub fallita");
      res.redirect(failure);
    }
  });

  router.delete("/auth/github", requireAuth, sessionOnly, async (req, res, next) => {
    try {
      await unlinkIdentity(currentUserId(req), "github");
      res.status(204).end();
    } catch (err) {
      if (err instanceof IdentityConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}

function toIdentity(
  ghUser: { id: string; login: string; name: string | null; avatarUrl: string | null },
  emails: string[],
  primaryEmail: string,
): LoginIdentity {
  return {
    provider: "github",
    providerUserId: ghUser.id,
    emails,
    primaryEmail,
    username: ghUser.login,
    name: ghUser.name,
    picture: ghUser.avatarUrl,
  };
}

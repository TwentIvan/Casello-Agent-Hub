import { eq } from "drizzle-orm";
import { appsTable, db, type App } from "@workspace/db";
import { embedAllowedOrigins, normalizeEmbedOrigin } from "../embed/origins";
import { logger } from "../logger";
import { appIdentitySecret, IDENTITY_MESSAGES, verifyIdentityToken } from "./identity";
import { BUG_MESSAGES, BugError } from "./messages";
import { hashBrowserKey, type Requester } from "./reports";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BROWSER_KEY = /^[A-Za-z0-9_-]{43}$/;

/**
 * App che accetta segnalazioni da una pagina ospite: origine ammessa (`EMBED_ALLOWED_ORIGINS`) e uguale all'origine del
 * `base_url` dell'App, App con le segnalazioni attive. Ogni altro caso è null: i chiamanti rispondono sempre lo stesso 404.
 */
export async function resolveEmbedBugApp(slug: string | undefined, origin: string | undefined): Promise<App | null> {
  if (!slug || !origin || !SLUG.test(slug)) return null;
  const normalized = normalizeEmbedOrigin(origin);
  if (normalized === null || !embedAllowedOrigins().includes(normalized)) return null;
  const [app] = await db.select().from(appsTable).where(eq(appsTable.slug, slug));
  if (!app || !app.bugReportsEnabled) return null;
  let appOrigin: string | null;
  try {
    appOrigin = normalizeEmbedOrigin(new URL(app.baseUrl).origin);
  } catch {
    return null;
  }
  return appOrigin === normalized ? app : null;
}

/** Segreto d'identità in chiaro; un valore salvato illeggibile vale «nessuna identità» (mai il valore nel log). */
async function secretOf(app: App): Promise<string | null> {
  try {
    return await appIdentitySecret(app.id);
  } catch {
    logger.warn({ appId: app.id }, "Segreto d'identità illeggibile: ignorato");
    return null;
  }
}

/** Se l'App ha un segreto d'identità configurato (per `GET /embed/config`). */
export function hasIdentitySecret(app: App): boolean {
  return app.identitySecretEnc !== null;
}

/**
 * Chi segnala: con un token d'identità valido la persona dell'app ospite, altrimenti il browser (hash della chiave).
 * Token non valido o scaduto con un segreto configurato → 401; senza segreto il token si ignora.
 */
export async function resolveRequester(
  app: App,
  browserKey: string | undefined,
  identityToken: string | undefined,
): Promise<Requester> {
  if (!browserKey || !BROWSER_KEY.test(browserKey)) throw new BugError(400, BUG_MESSAGES.invalidBrowserKey);
  if (identityToken) {
    const secret = await secretOf(app);
    if (secret) {
      const check = verifyIdentityToken(identityToken, secret, app.slug);
      if (!check.ok) throw new BugError(401, IDENTITY_MESSAGES[check.reason]);
      const { sub, name, email } = check.identity;
      return { kind: "identity", sub, name, email };
    }
  }
  return { kind: "browser", keyHash: hashBrowserKey(browserKey) };
}


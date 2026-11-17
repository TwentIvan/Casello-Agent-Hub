// Esempio di firma del token d'identità di Botcave (solo node:crypto, nessuna dipendenza).
// Prova: BOTCAVE_IDENTITY_SECRET=bci_... BOTCAVE_APP=mia-app node botcave-identity.mjs
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_TTL_SECONDS = 600;

const b64url = (data) => Buffer.from(data).toString("base64url");

/**
 * Firma un JWT HS256 per Botcave.
 * @param {{ id: string, name?: string, email?: string }} user utente collegato all'app
 * @param {{ secret: string, appSlug: string, ttlSeconds?: number, now?: Date }} opts
 *   `secret`: la stringa intera `bci_…` (è la chiave HMAC così com'è, in UTF-8, senza decodificarla);
 *   `appSlug`: lo slug dell'App in Botcave; `ttlSeconds`: durata, default 300, massimo 600.
 */
export function signBotcaveToken(user, { secret, appSlug, ttlSeconds = 300, now = new Date() }) {
  if (!secret) throw new Error("segreto d'identità mancante");
  if (!appSlug) throw new Error("slug dell'App mancante");
  if (!user || typeof user.id !== "string" || user.id.length < 1 || user.id.length > 200) {
    throw new Error("user.id deve essere una stringa di 1..200 caratteri");
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`ttlSeconds deve essere tra 1 e ${MAX_TTL_SECONDS}`);
  }
  const iat = Math.floor(now.getTime() / 1000);
  const claims = { iss: appSlug, aud: "botcave", sub: user.id, iat, exp: iat + ttlSeconds };
  if (user.name) claims.name = String(user.name).slice(0, 100);
  if (user.email) claims.email = String(user.email).slice(0, 254);

  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

// Eseguito da riga di comando: stampa un token di prova.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.BOTCAVE_IDENTITY_SECRET;
  const appSlug = process.env.BOTCAVE_APP;
  if (!secret || !appSlug) {
    console.error("Imposta BOTCAVE_IDENTITY_SECRET (il segreto bci_…) e BOTCAVE_APP (lo slug dell'App).");
    process.exit(1);
  }
  console.log(signBotcaveToken({ id: "utente-di-prova", name: "Utente di prova" }, { secret, appSlug }));
}

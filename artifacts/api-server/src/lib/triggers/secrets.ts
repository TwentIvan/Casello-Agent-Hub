import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { oauthBase } from "../oauth/config";

// Segreto dell'URL dei webhook (spec §5.1): `whs_` + 32 byte casuali in base64url. Nel DB solo l'hash SHA-256;
// l'URL completo si mostra una volta sola. Il segreto non deve mai finire nei log (vedi `redactHookPath`).

const SECRET_PREFIX = "whs_";

export function hashWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateWebhookSecret(): { secret: string; hash: string } {
  const secret = `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { secret, hash: hashWebhookSecret(secret) };
}

/** Confronto a tempo costante tra l'hash del segreto ricevuto e quello salvato. */
export function secretMatches(secret: string, hash: string): boolean {
  const got = Buffer.from(hashWebhookSecret(secret), "hex");
  const want = /^[0-9a-f]{64}$/i.test(hash) ? Buffer.from(hash, "hex") : null;
  // Con un hash salvato non valido si confronta comunque, contro sé stesso, per non cambiare i tempi.
  const equal = timingSafeEqual(got, want ?? got);
  return want !== null && equal;
}

/** Indirizzo pubblico del webhook, con la stessa origine del connettore OAuth (`PUBLIC_APP_URL`). */
export function webhookUrl(triggerId: number, secret: string): string {
  return `${oauthBase().issuer}/api/hooks/${triggerId}/${secret}`;
}

const HOOK_PATH = /^(\/api\/hooks\/)([^/?#]*)/i;

/** Percorso per i log: `/api/hooks/<id>/<qualsiasi>` → `/api/hooks/<id>/***`; un primo segmento non numerico si oscura. */
export function redactHookPath(url: string): string {
  const match = HOOK_PATH.exec(url);
  if (!match) return url;
  const [, prefix, first] = match;
  return /^\d+$/.test(first!) ? `${prefix}${first}/***` : `${prefix}***`;
}

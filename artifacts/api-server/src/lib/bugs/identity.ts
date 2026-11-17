import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { appsTable, db } from "@workspace/db";
import { decryptSecret } from "../secrets";

/** Messaggi fissi della verifica dell'identità. */
export const IDENTITY_MESSAGES = {
  invalid: "identità non valida",
  expired: "identità scaduta",
} as const;

export const IDENTITY_TOKEN_MAX = 4096;
export const IDENTITY_MAX_TTL_S = 600;
export const IDENTITY_SKEW_S = 60;

const SUB_MAX = 200;
const NAME_MAX = 100;
const EMAIL_MAX = 254;
const AUDIENCE = "botcave";

export type Identity = {
  sub: string;
  name: string | null;
  email: string | null;
  expiresAt: Date;
};

export type IdentityCheck =
  | { ok: true; identity: Identity }
  | { ok: false; reason: "invalid" | "expired" };

const INVALID: IdentityCheck = { ok: false, reason: "invalid" };

/** Base64url rigoroso: solo l'alfabeto URL, senza padding, forma canonica. */
function decodeB64url(segment: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const buf = Buffer.from(segment, "base64url");
  if (buf.toString("base64url") !== segment) return null;
  return buf;
}

function parseJsonObject(buf: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(buf.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** null = assente; undefined = presente ma non valido. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) return undefined;
  return value;
}

/**
 * Verifica un JWT HS256 mandato da un'app ospite (vedi spec «Identità degli
 * utenti»). Pura: nessuna lettura di DB, rete o orologio oltre a `now`.
 * La chiave HMAC è la stringa intera del segreto in UTF-8.
 */
export function verifyIdentityToken(
  token: string,
  secret: string,
  appSlug: string,
  now: Date = new Date(),
): IdentityCheck {
  if (typeof token !== "string" || token.length === 0 || token.length > IDENTITY_TOKEN_MAX) return INVALID;
  if (!secret) return INVALID;
  const parts = token.split(".");
  if (parts.length !== 3) return INVALID;
  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];

  const headerBuf = decodeB64url(headerPart);
  const payloadBuf = decodeB64url(payloadPart);
  const sigBuf = decodeB64url(sigPart);
  if (!headerBuf || !payloadBuf || !sigBuf) return INVALID;

  const header = parseJsonObject(headerBuf);
  if (!header || header.alg !== "HS256") return INVALID;
  if (header.typ !== undefined && header.typ !== "JWT") return INVALID;

  const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest();
  if (sigBuf.length !== expected.length || !timingSafeEqual(sigBuf, expected)) return INVALID;

  // Solo dopo la firma si guarda il contenuto.
  const claims = parseJsonObject(payloadBuf);
  if (!claims) return INVALID;

  if (claims.iss !== appSlug) return INVALID;
  const aud = claims.aud;
  if (!(aud === AUDIENCE || (Array.isArray(aud) && aud.includes(AUDIENCE)))) return INVALID;

  const { sub, iat, exp } = claims;
  if (typeof sub !== "string" || sub.length < 1 || sub.length > SUB_MAX) return INVALID;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return INVALID;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return INVALID;
  const name = optionalText(claims.name, NAME_MAX);
  const email = optionalText(claims.email, EMAIL_MAX);
  if (name === undefined || email === undefined) return INVALID;

  const nowS = now.getTime() / 1000;
  if (iat > nowS + IDENTITY_SKEW_S) return INVALID;
  if (exp - iat > IDENTITY_MAX_TTL_S) return INVALID;
  if (exp + IDENTITY_SKEW_S < nowS) return { ok: false, reason: "expired" };

  return { ok: true, identity: { sub, name, email, expiresAt: new Date(exp * 1000) } };
}

/** Nuovo segreto d'identità: `bci_` + 32 byte casuali in base64url. */
export function generateIdentitySecret(): string {
  return `bci_${randomBytes(32).toString("base64url")}`;
}

/** Segreto d'identità dell'App in chiaro, o null se non impostato. */
export async function appIdentitySecret(appId: number): Promise<string | null> {
  const [row] = await db
    .select({ enc: appsTable.identitySecretEnc })
    .from(appsTable)
    .where(eq(appsTable.id, appId));
  return row?.enc ? decryptSecret(row.enc) : null;
}

import { isIP } from "node:net";
import { appBaseDomain } from "./config";
import { APP_BOOTSTRAP_MESSAGES as M } from "./messages";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Messaggio d'errore o null se lo slug è valido. */
export function validateSlug(s: string): string | null {
  if (!SLUG_RE.test(s)) return M.slugInvalid;
  if (s === "casello") return M.slugReserved;
  return null;
}

function publicHost(): string | null {
  const raw = process.env["PUBLIC_APP_URL"]?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeDomain(
  raw: string,
): { ok: true; domain: string } | { ok: false; message: string } {
  let d = raw.trim().toLowerCase();
  if (d.endsWith(".")) d = d.slice(0, -1);
  const bad = { ok: false as const, message: M.domainInvalid };
  if (d.length < 1 || d.length > 253) return bad;
  const labels = d.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return bad;
  // Un dominio con etichette tutte numeriche vale come un indirizzo IP.
  if (isIP(d) !== 0 || labels.every((l) => /^[0-9]+$/.test(l))) return bad;
  if (d === "localhost" || d.endsWith(".localhost")) return bad;
  if (d === publicHost()) return bad;
  return { ok: true, domain: d };
}

export function defaultDomain(slug: string): string {
  return `${slug}.${appBaseDomain()}`;
}

export function bootstrapNames(slug: string, owner: string) {
  const o = owner.toLowerCase();
  return {
    apiImage: `ghcr.io/${o}/${slug}-api`,
    webImage: `ghcr.io/${o}/${slug}-web`,
    apiService: `${slug}-api`,
    webService: `${slug}-web`,
    webDir: `artifacts/${slug}-web`,
  };
}

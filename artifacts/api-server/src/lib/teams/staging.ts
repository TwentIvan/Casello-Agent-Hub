// Versione di prova dell'App (lavoro su branch unico, spec 2026-11-16-botcave-evoluzione-automatica §15.1): il branch di prova lo
// riscrive Botcave a ogni lavoro (unica scrittura forzata), quindi non può essere il base, `main`/`master` né un branch di Botcave.

export const STAGING_MESSAGES = {
  branch: "branch di prova non valido",
  url: "indirizzo di prova non valido",
} as const;

const RESERVED = new Set(["main", "master"]);
// Caratteri e sequenze vietati nei nomi dei ref di Git (git check-ref-format), più lo spazio
const FORBIDDEN = /[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|\/\.|^\.|\.$/;

/** Null se il nome va bene come branch di prova, altrimenti il messaggio fisso. */
export function checkStagingBranch(name: string, baseBranch: string | null): string | null {
  if (name.length < 1 || name.length > 100) return STAGING_MESSAGES.branch;
  if (name === "@" || FORBIDDEN.test(name) || name.startsWith("/") || name.endsWith("/") || name.endsWith(".lock")) return STAGING_MESSAGES.branch;
  if (RESERVED.has(name) || name.startsWith("botcave/") || (baseBranch !== null && name === baseBranch)) return STAGING_MESSAGES.branch;
  return null;
}

/** Null se l'indirizzo di prova è https e al più 500 caratteri, altrimenti il messaggio fisso. */
export function checkStagingUrl(url: string): string | null {
  if (url.length > 500) return STAGING_MESSAGES.url;
  try {
    return new URL(url).protocol === "https:" ? null : STAGING_MESSAGES.url;
  } catch {
    return STAGING_MESSAGES.url;
  }
}

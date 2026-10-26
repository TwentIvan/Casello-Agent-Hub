/**
 * Pulizia dei valori che arrivano da provider e fonti pubbliche: prezzi, contesto, id e nomi.
 * Condivisa dalla scoperta dei modelli (`discovery.ts`) e dalle fonti del catalogo.
 */

/** Prezzi oltre questa soglia (USD per milione di token) sono considerati dati sbagliati. */
const MAX_PRICE_PER_MTOK = 1e6;
const MAX_NAME_LENGTH = 256;
const MAX_ID_LENGTH = 256;
// Solo numeri decimali (con esponente opzionale): niente esadecimali, Infinity, segni
const DECIMAL_RE = /^\d+(\.\d+)?([eE][-+]?\d+)?$/;
// Caratteri di controllo C0, DEL e C1
// eslint-disable-next-line no-control-regex
export const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** Prezzo per token (numero o stringa decimale, come OpenRouter) → USD per milione, arrotondato a 6 decimali. */
export function perMillion(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && DECIMAL_RE.test(v.trim())) n = Number(v.trim());
  else return null;
  if (!Number.isFinite(n) || n < 0) return null;
  const perMtok = Math.round(n * 1e12) / 1e6;
  return Number.isFinite(perMtok) && perMtok < MAX_PRICE_PER_MTOK ? perMtok : null;
}

/** Contesto in token: intero positivo, anche come stringa decimale intera. */
export function contextTokens(v: unknown): number | null {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Id: stringa senza spazi ai bordi, 1–256 caratteri, senza caratteri di controllo. */
export function cleanId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim();
  return id === "" || id.length > MAX_ID_LENGTH || CONTROL_RE.test(id) ? null : id;
}

/** Nome da mostrare: senza spazi ai bordi né caratteri di controllo, troncato a 256 caratteri. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = v.trim();
  return name === "" || CONTROL_RE.test(name) ? null : name.slice(0, MAX_NAME_LENGTH);
}

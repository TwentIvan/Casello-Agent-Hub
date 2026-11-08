import { looksLikeCredential } from "../memory/credentials";
import type { AppConnection, ExtraHeader } from "./types";

// Regole sui nomi e sui valori degli header verso le app: header di autenticazione e header fissi.
// Funzioni pure, usate al salvataggio dell'app (route) e a ogni chiamata (esecutore HTTP e client MCP).

// Token HTTP (RFC 9110) per i nomi di header
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Header che la configurazione dell'app non può sovrascrivere
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "accept",
]);
// Header del protocollo MCP (Streamable HTTP), gestiti dal client: un header fisso non li tocca
const MCP_PROTOCOL_HEADERS = new Set(["mcp-session-id", "mcp-protocol-version", "last-event-id"]);
// Valore di un header: solo caratteri visibili ASCII, spazio e tab (niente CR/LF o byte di controllo)
const HEADER_VALUE = /^[\t\x20-\x7e]+$/;

export const MAX_EXTRA_HEADERS = 10;
export const MAX_EXTRA_HEADER_VALUE = 500;

/** Motivo (in italiano) per cui un nome di header di autenticazione non è ammesso, o null. */
export function checkAuthHeaderName(header: string): string | null {
  if (!HEADER_NAME.test(header)) return "nome di header non valido";
  if (RESERVED_HEADERS.has(header.toLowerCase())) return `l'header "${header}" è riservato`;
  return null;
}

/** Valore ammesso in un header HTTP (visibile, su una riga). */
export function isValidHeaderValue(value: string): boolean {
  return HEADER_VALUE.test(value);
}

/** Motivo per cui il nome di un header fisso non è ammesso, o null: regole dell'autenticazione più quelle del protocollo MCP. */
function checkExtraHeaderName(name: string): string | null {
  const error = checkAuthHeaderName(name);
  if (error) return error;
  if (MCP_PROTOCOL_HEADERS.has(name.toLowerCase())) return `l'header "${name}" è riservato`;
  return null;
}

/** Nomi e valori senza spazi ai bordi: si salvano così. */
export function normalizeExtraHeaders(headers: ExtraHeader[]): ExtraHeader[] {
  return headers.map((h) => ({ name: h.name.trim(), value: h.value.trim() }));
}

/**
 * Header fissi di un'app (già normalizzati), nello stato risultante del salvataggio: al più 10, nomi validi e non
 * ripetuti, diversi dagli header di autenticazione utente e di servizio, valori di 1..500 caratteri visibili su una
 * riga e che non sembrano credenziali. Restituisce il primo motivo (in italiano, mai con il valore) o null.
 */
export function checkExtraHeaders(
  headers: ExtraHeader[],
  auth: { userAuthHeader?: string | null; serviceAuthHeader?: string | null },
): string | null {
  if (headers.length > MAX_EXTRA_HEADERS) return `al massimo ${MAX_EXTRA_HEADERS} header fissi`;
  const authNames = [auth.userAuthHeader, auth.serviceAuthHeader]
    .filter((n): n is string => !!n)
    .map((n) => n.toLowerCase());
  const seen = new Set<string>();
  for (const { name, value } of headers) {
    const nameError = checkExtraHeaderName(name);
    if (nameError) return nameError;
    const key = name.toLowerCase();
    if (seen.has(key)) return `nome di header ripetuto: ${name}`;
    seen.add(key);
    if (authNames.includes(key)) return `l'header ${name} è già quello di autenticazione dell'app`;
    if (value.length < 1 || value.length > MAX_EXTRA_HEADER_VALUE || value !== value.trim() || !isValidHeaderValue(value)) {
      return `valore dell'header ${name} non valido (1-${MAX_EXTRA_HEADER_VALUE} caratteri visibili su una riga)`;
    }
    if (looksLikeCredential(value)) return "non salvare credenziali negli header fissi: usa il segreto di servizio";
  }
  return null;
}

/**
 * Header fissi da mandare in una chiamata. Difesa in profondità sui dati salvati: si scartano i nomi non ammessi,
 * quelli uguali a un header di autenticazione dell'app, i doppioni e i valori non validi. L'autenticazione si imposta
 * dopo e vince sempre.
 */
export function extraHeadersFor(conn: AppConnection): [string, string][] {
  const authNames = new Set(
    [conn.userAuth?.header, conn.serviceAuth?.header].filter((n): n is string => !!n).map((n) => n.toLowerCase()),
  );
  const seen = new Set<string>();
  const result: [string, string][] = [];
  for (const h of conn.extraHeaders ?? []) {
    if (typeof h?.name !== "string" || typeof h.value !== "string") continue;
    const key = h.name.toLowerCase();
    if (checkExtraHeaderName(h.name) !== null || authNames.has(key) || seen.has(key)) continue;
    if (!isValidHeaderValue(h.value)) continue;
    seen.add(key);
    result.push([h.name, h.value]);
  }
  return result;
}

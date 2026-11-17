// Protocollo dei messaggi postMessage tra la pagina ospite e l'iframe di Botcave.
// Tipi e campi chiusi: i campi in più si scartano, i valori fuori limite si rifiutano.
import { THEME_VARS, cleanFontUrl, cleanThemeValue, type HostTheme } from "./theme";

export type { HostTheme, ThemeVar } from "./theme";

// Tenute allineate con `TABS` qui sotto e con `tabOrder` di components/panel/tabs.ts
export type EmbedTab = "alfred" | "lucius" | "lead" | "pending" | "bulletin" | "bugs";

export type HostContextMsg = { page: string; id?: string; title?: string };

/** Stato per il pulsante della pagina ospite: contatori, bot al lavoro, risposta non vista, azioni della pagina (0..6). */
export type StatusPayload = { pending: number; bugs: number; working: boolean; unread: boolean; actions: number };

/** Richiesta di apertura: scheda facoltativa; `focusContext` mostra la barra «Stai guardando» aperta. */
export type OpenPayload = { tab?: EmbedTab; focusContext?: true };

/** Azioni al più per tipo di pagina (come sul server). */
export const MAX_PAGE_ACTIONS = 6;

export type ToFrame =
  | { botcave: 1; type: "theme"; payload: HostTheme }
  | { botcave: 1; type: "context"; payload: HostContextMsg }
  | { botcave: 1; type: "open"; payload: OpenPayload }
  | { botcave: 1; type: "identity"; payload: { token: string | null } };

export type FromFrame =
  | { botcave: 1; type: "ready" }
  | { botcave: 1; type: "close" }
  | { botcave: 1; type: "identity_request" }
  | { botcave: 1; type: "status"; payload: StatusPayload }
  | { botcave: 1; type: "error"; payload: { code: "host_not_allowed" | "unreachable" } };

const TABS: readonly string[] = ["alfred", "lucius", "lead", "pending", "bulletin", "bugs"];
const TOKEN_RE = /^[A-Za-z0-9_.-]{1,4096}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,40}$/;

/** Il token d'identità come lo accetta l'iframe: base64url e punti, 1..4096 caratteri. */
export function isIdentityToken(v: unknown): v is string {
  return typeof v === "string" && TOKEN_RE.test(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTheme(p: unknown): HostTheme | null {
  if (!isRecord(p)) return null;
  if (p.mode !== "light" && p.mode !== "dark") return null;
  const vars: HostTheme["vars"] = {};
  if (isRecord(p.vars)) {
    for (const name of THEME_VARS) {
      const raw = p.vars[name];
      if (typeof raw !== "string") continue;
      const clean = cleanThemeValue(name, raw);
      if (clean !== null) vars[name] = clean;
    }
  }
  const theme: HostTheme = { mode: p.mode, vars };
  const fontUrl = cleanFontUrl(p.fontUrl);
  if (fontUrl) theme.fontUrl = fontUrl;
  return theme;
}

function parseContext(p: unknown): HostContextMsg | null {
  if (!isRecord(p)) return null;
  if (typeof p.page !== "string" || !ID_RE.test(p.page)) return null;
  const out: HostContextMsg = { page: p.page };
  if (p.id !== undefined) {
    if (typeof p.id !== "string" || !ID_RE.test(p.id)) return null;
    out.id = p.id;
  }
  if (p.title !== undefined) {
    if (typeof p.title !== "string") return null;
    if (p.title.length < 1 || p.title.length > 200 || /[\r\n]/.test(p.title)) return null;
    out.title = p.title;
  }
  return out;
}

export function parseToFrame(data: unknown): ToFrame | null {
  if (!isRecord(data) || data.botcave !== 1) return null;
  switch (data.type) {
    case "theme": {
      const payload = parseTheme(data.payload);
      return payload ? { botcave: 1, type: "theme", payload } : null;
    }
    case "context": {
      const payload = parseContext(data.payload);
      return payload ? { botcave: 1, type: "context", payload } : null;
    }
    case "open": {
      if (data.payload === undefined) return { botcave: 1, type: "open", payload: {} };
      if (!isRecord(data.payload)) return null;
      const payload: OpenPayload = {};
      const tab = data.payload.tab;
      if (tab !== undefined) {
        if (typeof tab !== "string" || !TABS.includes(tab)) return null;
        payload.tab = tab as EmbedTab;
      }
      // Solo `true`: ogni altro valore vale come assente
      if (data.payload.focusContext === true) payload.focusContext = true;
      return { botcave: 1, type: "open", payload };
    }
    case "identity": {
      if (!isRecord(data.payload)) return null;
      const token = data.payload.token;
      if (token === null) return { botcave: 1, type: "identity", payload: { token: null } };
      if (!isIdentityToken(token)) return null;
      return { botcave: 1, type: "identity", payload: { token } };
    }
    default:
      return null;
  }
}

/** Messaggio `context` per `Botcave.setContext` del caricatore, validato come lo valida l'iframe; null se non valido. */
export function contextMessage(c: unknown): Extract<ToFrame, { type: "context" }> | null {
  const payload = parseContext(c);
  return payload ? { botcave: 1, type: "context", payload } : null;
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function parseStatus(p: unknown): StatusPayload | null {
  if (!isRecord(p)) return null;
  const { pending, bugs, working, unread, actions } = p;
  if (!isCount(pending) || !isCount(bugs) || !isCount(actions) || actions > MAX_PAGE_ACTIONS) return null;
  if (typeof working !== "boolean" || typeof unread !== "boolean") return null;
  return { pending, bugs, working, unread, actions };
}

export function parseFromFrame(data: unknown): FromFrame | null {
  if (!isRecord(data) || data.botcave !== 1) return null;
  switch (data.type) {
    case "ready":
      return { botcave: 1, type: "ready" };
    case "close":
      return { botcave: 1, type: "close" };
    case "identity_request":
      return { botcave: 1, type: "identity_request" };
    case "status": {
      const payload = parseStatus(data.payload);
      return payload ? { botcave: 1, type: "status", payload } : null;
    }
    // Messaggio degli iframe di prima, solo con il contatore delle voci da confermare: da togliere 30 giorni dopo il
    // deploy del messaggio `status` (le pagine ospiti tengono botcave.js in cache)
    case "badge": {
      const p = data.payload;
      if (!isRecord(p) || !isCount(p.pending)) return null;
      return { botcave: 1, type: "status", payload: { pending: p.pending, bugs: 0, working: false, unread: false, actions: 0 } };
    }
    case "error": {
      const p = data.payload;
      if (!isRecord(p)) return null;
      if (p.code !== "host_not_allowed" && p.code !== "unreachable") return null;
      return { botcave: 1, type: "error", payload: { code: p.code } };
    }
    default:
      return null;
  }
}

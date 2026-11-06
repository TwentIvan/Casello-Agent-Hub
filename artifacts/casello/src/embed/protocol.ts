// Protocollo dei messaggi postMessage tra la pagina ospite e l'iframe di Botcave.
// Tipi e campi chiusi: i campi in più si scartano, i valori fuori limite si rifiutano.
import { THEME_VARS, cleanFontUrl, cleanThemeValue, type HostTheme } from "./theme";

export type { HostTheme, ThemeVar } from "./theme";

export type EmbedTab = "alfred" | "pending" | "bulletin" | "lucius";

export type HostContextMsg = { page: string; id?: string; title?: string };

export type ToFrame =
  | { botcave: 1; type: "theme"; payload: HostTheme }
  | { botcave: 1; type: "context"; payload: HostContextMsg }
  | { botcave: 1; type: "open"; payload: { tab?: EmbedTab } };

export type FromFrame =
  | { botcave: 1; type: "ready" }
  | { botcave: 1; type: "close" }
  | { botcave: 1; type: "badge"; payload: { pending: number } }
  | { botcave: 1; type: "error"; payload: { code: "host_not_allowed" | "unreachable" } };

const TABS: readonly string[] = ["alfred", "pending", "bulletin", "lucius"];
const ID_RE = /^[A-Za-z0-9._:-]{1,40}$/;

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
      const tab = data.payload.tab;
      if (tab === undefined) return { botcave: 1, type: "open", payload: {} };
      if (typeof tab !== "string" || !TABS.includes(tab)) return null;
      return { botcave: 1, type: "open", payload: { tab: tab as EmbedTab } };
    }
    default:
      return null;
  }
}

export function parseFromFrame(data: unknown): FromFrame | null {
  if (!isRecord(data) || data.botcave !== 1) return null;
  switch (data.type) {
    case "ready":
      return { botcave: 1, type: "ready" };
    case "close":
      return { botcave: 1, type: "close" };
    case "badge": {
      const p = data.payload;
      if (!isRecord(p)) return null;
      const n = p.pending;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
      return { botcave: 1, type: "badge", payload: { pending: n } };
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

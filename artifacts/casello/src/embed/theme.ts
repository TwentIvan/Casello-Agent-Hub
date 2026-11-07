// Tema dell'ospite: filtro e traduzione delle variabili nei token di Botcave.
// Funzioni pure, nessun accesso al DOM.

export const THEME_VARS = [
  "background",
  "foreground",
  "primary",
  "primary-foreground",
  "muted",
  "muted-foreground",
  "border",
  "radius",
  "font-sans",
] as const;

export type ThemeVar = (typeof THEME_VARS)[number];

export type HostTheme = {
  mode: "light" | "dark";
  vars: Partial<Record<ThemeVar, string>>;
  fontUrl?: string;
};

const FONT_URL_PREFIX = "https://fonts.googleapis.com/";

const NUM = String.raw`-?\d*\.?\d+`;
// Tripletta shadcn: «H S% L%», con alfa facoltativo.
const SHADCN_HSL = new RegExp(`^${NUM}(deg)? ${NUM}% ${NUM}%( / ${NUM}%?)?$`);
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// Funzioni colore: solo numeri, %, ., spazi, / e virgole dentro le parentesi.
const COLOR_FN = /^(?:rgb|rgba|hsl|hsla|oklch)\([0-9%.,/\s-]+\)$/;
const LENGTH = /^\d+(\.\d+)?(rem|px)$/;
const FONT_FAMILY = /^[A-Za-z0-9 ,'"-]{1,200}$/;

function isColor(v: string): boolean {
  return SHADCN_HSL.test(v) || HEX.test(v) || COLOR_FN.test(v);
}

/** Valida il valore di una variabile del tema; `null` se non ammesso. */
export function cleanThemeValue(name: ThemeVar, value: string): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.length === 0 || v.length > 200) return null;
  if (name === "radius") return LENGTH.test(v) ? v : null;
  if (name === "font-sans") return FONT_FAMILY.test(v) ? v : null;
  return isColor(v) ? v : null;
}

/** `fontUrl` ammesso solo da Google Fonts. */
export function cleanFontUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length > 2000) return undefined;
  if (!url.startsWith(FONT_URL_PREFIX)) return undefined;
  if (/[\s"'<>()\\]/.test(url)) return undefined;
  return url;
}

const CSS_NAMES: Record<ThemeVar, string> = {
  background: "--surface-1",
  foreground: "--ink",
  primary: "--accent",
  "primary-foreground": "--on-accent",
  muted: "--surface-2",
  "muted-foreground": "--ink-muted",
  border: "--border",
  radius: "--radius-md",
  "font-sans": "--font-sans",
};

/** Variabili CSS dei token Botcave da impostare su `<html>` della pagina `/embed`. */
export function themeToCss(theme: HostTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of THEME_VARS) {
    const raw = theme.vars[name];
    if (raw === undefined) continue;
    const clean = cleanThemeValue(name, raw);
    if (clean === null) continue;
    const value = SHADCN_HSL.test(clean) ? `hsl(${clean})` : clean;
    out[CSS_NAMES[name]] = value;
    if (name === "primary") out["--accent-text"] = value;
  }
  return out;
}

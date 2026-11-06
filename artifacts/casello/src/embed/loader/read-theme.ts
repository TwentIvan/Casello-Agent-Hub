// Legge il tema della pagina ospite. Input strutturali, così si prova senza DOM.
import { THEME_VARS, cleanFontUrl, cleanThemeValue, type HostTheme } from "../theme";

type RootLike = {
  classList: { contains(c: string): boolean };
  getAttribute(n: string): string | null;
};
type StyleLike = { getPropertyValue(n: string): string };

export function readHostTheme(
  root: RootLike,
  getStyle: (el: never) => StyleLike,
  links: string[],
): HostTheme {
  const style = (getStyle as (el: RootLike) => StyleLike)(root);
  const dark =
    root.classList.contains("dark") ||
    root.getAttribute("data-theme") === "dark" ||
    style.getPropertyValue("color-scheme").trim() === "dark";
  const vars: HostTheme["vars"] = {};
  for (const name of THEME_VARS) {
    const raw = style.getPropertyValue(`--${name}`);
    if (!raw) continue;
    const clean = cleanThemeValue(name, raw);
    if (clean !== null) vars[name] = clean;
  }
  const theme: HostTheme = { mode: dark ? "dark" : "light", vars };
  for (const href of links) {
    const url = cleanFontUrl(href);
    if (url) {
      theme.fontUrl = url;
      break;
    }
  }
  return theme;
}

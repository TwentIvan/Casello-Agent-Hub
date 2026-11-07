// Router di wouter del pannello incorporato: l'iframe non ha pagine, quindi la posizione resta "/embed" e i <Link> dei
// componenti riusati della console (es. «Apri Da confermare», «C'è un piano più recente») aprono la console di Botcave in
// una nuova scheda. Gli href sono assoluti sull'origine di Botcave, così anche il clic centrale porta alla console.
import type { BaseLocationHook } from "wouter";

export const EMBED_PATH = "/embed";

/** Indirizzo assoluto della console per un percorso; un indirizzo di un'altra origine diventa la radice di Botcave. */
export function consoleLinkHref(to: string, origin: string): string {
  const url = new URL(to, origin);
  return url.origin === origin ? url.href : new URL("/", origin).href;
}

function navigate(to: string): void {
  window.open(consoleLinkHref(to, window.location.origin), "_blank", "noopener");
}

/** Posizione fissa: il pannello non naviga mai al suo interno (e il pannello laterale dei personaggi non si chiude). */
export const useEmbedLocation: BaseLocationHook = () => [EMBED_PATH, navigate];

/** `hrefs` del Router: gli href dei <Link> puntano alla console di Botcave. */
export const embedHrefs = (href: string): string => consoleLinkHref(href, window.location.origin);

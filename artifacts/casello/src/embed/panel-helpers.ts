// Funzioni pure delle schede del pannello incorporato (contesto di Alfred, App di Lucius, contatore della coda).
import type { CharacterPageContext } from "@workspace/api-client-react";
import type { HostContextMsg } from "./protocol";

// Stesso formato che il server accetta in `CharacterPageContext.host.app`
const HOST_APP_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Slug dell'app dalla query di /embed: lo stesso formato del server, altrimenti stringa vuota. */
export function cleanAppSlug(raw: string | null): string {
  return raw !== null && HOST_APP_RE.test(raw) ? raw : "";
}

/** Contesto di Alfred: la pagina dell'app ospite se nota, altrimenti `console`. */
export function alfredPageContext(appSlug: string, ctx: HostContextMsg | null): CharacterPageContext {
  if (!ctx || !HOST_APP_RE.test(appSlug)) return { page: "console" };
  const host: NonNullable<CharacterPageContext["host"]> = { app: appSlug, page: ctx.page };
  if (ctx.id !== undefined) host.id = ctx.id;
  if (ctx.title !== undefined) host.title = ctx.title;
  return { page: "host", host };
}

/** L'App di Botcave con lo slug indicato dalla pagina ospite (confronto esatto), o null. */
export function findAppBySlug<T extends { slug: string }>(apps: readonly T[] | undefined, slug: string): T | null {
  if (!apps || !slug) return null;
  return apps.find((a) => a.slug === slug) ?? null;
}

export const BADGE_OPEN_MS = 5_000;
export const BADGE_CLOSED_MS = 30_000;

/** Pannello aperto: documento visibile e iframe mostrato dal caricatore. */
export function isPanelOpen(state: { visible: boolean; shown: boolean }): boolean {
  return state.visible && state.shown;
}

/** Intervallo del contatore: 5 s a pannello aperto, 30 s altrimenti. */
export function badgeIntervalMs(open: boolean): number {
  return open ? BADGE_OPEN_MS : BADGE_CLOSED_MS;
}

/** Valore da mandare alla pagina ospite, o null se non è cambiato o non è un intero ≥ 0. */
export function nextBadge(last: number | null, count: number): number | null {
  if (!Number.isInteger(count) || count < 0) return null;
  return count === last ? null : count;
}

/** Indirizzo di una pagina della console di Botcave (si apre in una nuova scheda). */
export function consoleUrl(origin: string, path: string): string {
  return `${origin}${path}`;
}

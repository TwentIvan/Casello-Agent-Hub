// Richieste del visitatore alle route pubbliche /api/embed/bugs*: solo gli header della chiave del browser e, se c'è,
// dell'identità firmata dall'app ospite; mai il token `embed` di Botcave (lo toglie il getter di embed-app.tsx).
import { ApiError } from "@workspace/api-client-react";

const VISITOR_PATH_RE = /^\/api\/embed\/bugs(?:\/|$)/;

/** Header di una richiesta del visitatore. */
export function bugRequestInit(key: string, identity: string | null): RequestInit {
  const headers: Record<string, string> = { "X-Botcave-Browser-Key": key };
  if (identity) headers["X-Botcave-Identity"] = identity;
  return { headers };
}

/**
 * Esegue la chiamata con l'identità attuale; su un 401 (identità non valida o scaduta) chiede all'app ospite
 * un'identità nuova e riprova una volta sola. Ogni altro errore, o un secondo 401, si propaga.
 */
export async function withIdentityRetry<T>(
  call: (identity: string | null) => Promise<T>,
  refresh: () => Promise<string | null>,
  identity: string | null = null,
): Promise<T> {
  try {
    return await call(identity);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
  }
  return call(await refresh());
}

/** Indirizzo (relativo o assoluto) di una route del visitatore. */
export function isVisitorBugUrl(url: string): boolean {
  try {
    return VISITOR_PATH_RE.test(new URL(url, "http://botcave.invalid").pathname);
  } catch {
    return false;
  }
}

/** Getter del token `embed` per il client generato: nessun token (e nessun rinnovo) sulle route del visitatore. */
export function embedTokenGetter(get: () => Promise<string | null> | string | null): (url: string) => Promise<string | null> | string | null {
  return (url) => (isVisitorBugUrl(url) ? null : get());
}

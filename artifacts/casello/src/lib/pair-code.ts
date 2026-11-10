/**
 * Codice di abbinamento di un Mac (`/nodes/pair?code=…`). Non deve finire nei log: il redirect del login porta
 * l'indirizzo corrente, quindi il codice si mette da parte in sessionStorage e il returnTo resta senza query.
 */
export const PAIR_PATH = "/nodes/pair";
export const PAIR_CODE_KEY = "botcave-pair-code";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Percorso (con query) da usare come returnTo del login; per la pagina di abbinamento tiene il codice fuori dall'indirizzo. */
export function returnToPath(url: URL, storage: StorageLike | null = defaultStorage()): string {
  if (url.pathname === PAIR_PATH) {
    const code = url.searchParams.get("code");
    if (code) {
      try {
        storage?.setItem(PAIR_CODE_KEY, code);
      } catch {
        // storage non disponibile: l'utente riaprirà il collegamento da Botcave Nodo
      }
    }
    return PAIR_PATH;
  }
  return `${url.pathname}${url.search}`;
}

/** Codice dall'indirizzo, altrimenti da sessionStorage. */
export function readPairCode(search: string, storage: StorageLike | null = defaultStorage()): string | null {
  const fromQuery = new URLSearchParams(search).get("code");
  if (fromQuery) return fromQuery;
  try {
    return storage?.getItem(PAIR_CODE_KEY) || null;
  } catch {
    return null;
  }
}

export function clearPairCode(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(PAIR_CODE_KEY);
  } catch {
    // niente da togliere
  }
}

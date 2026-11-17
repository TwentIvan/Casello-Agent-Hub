// Chiave del browser del visitatore per le segnalazioni dei bug: 32 byte casuali base64url, una per App, nello storage
// dell'iframe di Botcave (`botcave-bug-key:<slug>`). Il server conosce solo il suo hash: è il richiedente senza identità.
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const storageKey = (appSlug: string) => `botcave-bug-key:${appSlug}`;

// Storage non disponibile (bloccato, navigazione privata): la chiave resta in memoria per la sessione
const memoryKeys = new Map<string, string>();

function newKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function rememberedKey(name: string): string {
  let key = memoryKeys.get(name);
  if (!key) {
    key = newKey();
    memoryKeys.set(name, key);
  }
  return key;
}

/** La chiave del browser per l'App: quella salvata se valida, altrimenti una nuova (salvata se si può). */
export function loadOrCreateBrowserKey(appSlug: string, storage: StorageLike | null = defaultStorage()): string {
  const name = storageKey(appSlug);
  if (!storage) return rememberedKey(name);
  try {
    const saved = storage.getItem(name);
    if (saved !== null && KEY_RE.test(saved)) return saved;
    const key = newKey();
    storage.setItem(name, key);
    return key;
  } catch {
    return rememberedKey(name);
  }
}

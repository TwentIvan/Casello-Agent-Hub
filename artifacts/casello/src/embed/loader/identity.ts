// Identità dell'utente dell'app ospite: il caricatore chiede un token breve al server dell'app
// (stessa origine, con i suoi cookie) e lo passa all'iframe. Il token non si registra mai in console.
const MAX_TOKEN = 4096;

/** Solo un percorso relativo alla radice dell'app ospite; altrimenti null (il chiamante avvisa). */
export function identityPath(raw: string | undefined): string | null {
  if (!raw || raw.length > 500) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}

/** Legge `exp` (secondi) dal corpo del token senza verificarlo: serve solo a pianificare il rinnovo. */
export function tokenExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const body: unknown = JSON.parse(json);
    if (typeof body !== "object" || body === null) return null;
    const exp = (body as Record<string, unknown>).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** Attesa prima del rinnovo: un minuto prima della scadenza, almeno 5 s; null senza `exp`. */
export function refreshDelayMs(expSec: number | null, nowMs: number): number | null {
  if (expSec === null) return null;
  return Math.max(5_000, expSec * 1000 - 60_000 - nowMs);
}

/** Chiede il token al server dell'app: 200 `{token}` → token, 204 → null, il resto → null con un avviso. */
export async function fetchIdentity(path: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const fail = (why: string): null => {
    console.warn(`Botcave: identità non ottenuta (${why}), il pannello resta anonimo`);
    return null;
  };
  try {
    const res = await fetchFn(path, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (res.status === 204) return null;
    if (res.status !== 200) return fail(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    const token = typeof body === "object" && body !== null ? (body as Record<string, unknown>).token : undefined;
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN) return fail("risposta non valida");
    return token;
  } catch {
    return fail("richiesta non riuscita");
  }
}

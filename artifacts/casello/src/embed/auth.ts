// Collegamento della pagina /embed a Botcave: OAuth 2.1 con popup e PKCE, ambito `embed`.
// I token stanno solo nel localStorage dell'iframe (spazio separato per sito ospite); se lo storage non è
// disponibile restano in memoria per la sessione. Mai token, codici o verifier nei log.
// Le dipendenze del browser (fetch, window.open, storage, origine, orologio) sono iniettabili per i test in node.

export type EmbedTokens = {
  access: string;
  refresh: string;
  expiresAt: number;
  /** client OAuth che ha emesso i token: serve al rinnovo. */
  clientId?: string;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type OpenFn = (url: string, name: string, features: string) => unknown;

type AuthDeps = {
  fetch: typeof fetch;
  open: OpenFn;
  local: () => StorageLike | null;
  session: () => StorageLike | null;
  origin: () => string;
  now: () => number;
};

const TOKENS_KEY = "botcave-embed-tokens";
const PENDING_KEY = "botcave-embed-connect";
/** Rinnovo quando mancano meno di 60 s alla scadenza. */
const REFRESH_MARGIN_MS = 60_000;

function browserDeps(): AuthDeps {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    open: (url, name, features) => window.open(url, name, features),
    local: () => window.localStorage,
    session: () => window.sessionStorage,
    origin: () => window.location.origin,
    now: () => Date.now(),
  };
}

let deps: AuthDeps | null = null;

function d(): AuthDeps {
  if (!deps) deps = browserDeps();
  return deps;
}

/** Sostituisce alcune dipendenze (test). */
export function configureAuth(overrides: Partial<AuthDeps>): void {
  deps = { ...d(), ...overrides };
}

// --- Storage con ripiego in memoria ---------------------------------------------------------------

const memory = new Map<string, string>();

function storageGet(which: "local" | "session", key: string): string | null {
  try {
    const s = d()[which]();
    if (s) return s.getItem(key);
  } catch {
    // storage non disponibile: si usa la memoria
  }
  return memory.get(`${which}:${key}`) ?? null;
}

function storageSet(which: "local" | "session", key: string, value: string): void {
  try {
    const s = d()[which]();
    if (s) {
      s.setItem(key, value);
      memory.delete(`${which}:${key}`);
      return;
    }
  } catch {
    // ripiego in memoria
  }
  memory.set(`${which}:${key}`, value);
}

function storageRemove(which: "local" | "session", key: string): void {
  memory.delete(`${which}:${key}`);
  try {
    d()[which]()?.removeItem(key);
  } catch {
    // niente da fare
  }
}

// --- Token -----------------------------------------------------------------------------------------

type Listener = (tokens: EmbedTokens | null) => void;
const listeners = new Set<Listener>();

/** Avvisa quando i token cambiano (collegamento, rinnovo, scollegamento). */
export function onTokensChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(tokens: EmbedTokens | null): void {
  for (const l of listeners) l(tokens);
}

function isTokens(v: unknown): v is EmbedTokens {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.access === "string" &&
    typeof t.refresh === "string" &&
    typeof t.expiresAt === "number" &&
    (t.clientId === undefined || typeof t.clientId === "string")
  );
}

export function loadTokens(): EmbedTokens | null {
  const raw = storageGet("local", TOKENS_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isTokens(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveTokens(t: EmbedTokens): void {
  storageSet("local", TOKENS_KEY, JSON.stringify(t));
  notify(t);
}

export function clearTokens(): void {
  storageRemove("local", TOKENS_KEY);
  notify(null);
}

// --- PKCE ------------------------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function s256(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

type Pending = { verifier: string; state: string; clientId: string };

function redirectUri(): string {
  return `${d().origin()}/embed/callback`;
}

let popup: unknown = null;

/** Apre il popup di autorizzazione. Rifiuta con `popup_blocked` se il browser lo blocca. */
export async function startConnect(clientId: string): Promise<void> {
  const verifier = randomString(32); // 43 caratteri
  const state = randomString(24);
  const challenge = await s256(verifier);
  const pending: Pending = { verifier, state, clientId };
  storageSet("session", PENDING_KEY, JSON.stringify(pending));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "embed",
    resource: `${d().origin()}/mcp`,
  });
  const win = d().open(`/oauth/authorize?${q.toString()}`, "botcave-connect", "popup,width=480,height=640");
  if (!win) {
    storageRemove("session", PENDING_KEY);
    throw new Error("popup_blocked");
  }
  popup = win;
}

/** Messaggio del popup di ritorno: accettato solo dal popup aperto e dall'origine di Botcave. */
export function connectMessage(ev: { origin: string; source: unknown; data: unknown }): { code: string; state: string } | null {
  if (ev.origin !== d().origin() || popup === null || ev.source !== popup) return null;
  const data = ev.data as Record<string, unknown> | null;
  if (typeof data !== "object" || data === null || data.botcave !== 1 || data.type !== "connect") return null;
  const p = data.payload as Record<string, unknown> | null;
  if (typeof p !== "object" || p === null) return null;
  if (typeof p.code !== "string" || typeof p.state !== "string") return null;
  if (p.code.length < 1 || p.code.length > 512 || p.state.length < 1 || p.state.length > 500) return null;
  return { code: p.code, state: p.state };
}

function readPending(): Pending | null {
  const raw = storageGet("session", PENDING_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Pending>;
    if (typeof p.verifier !== "string" || typeof p.state !== "string" || typeof p.clientId !== "string") return null;
    return { verifier: p.verifier, state: p.state, clientId: p.clientId };
  } catch {
    return null;
  }
}

class TokenError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function tokenRequest(form: Record<string, string>, clientId: string): Promise<EmbedTokens> {
  const res = await d().fetch("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // risposta non JSON
  }
  if (!res.ok) throw new TokenError(typeof body.error === "string" ? body.error : "server_error");
  const { access_token, refresh_token, expires_in } = body;
  if (typeof access_token !== "string" || typeof refresh_token !== "string" || typeof expires_in !== "number") {
    throw new TokenError("server_error");
  }
  return { access: access_token, refresh: refresh_token, expiresAt: d().now() + expires_in * 1000, clientId };
}

/** Scambia il codice del popup con i token. `state` diverso → `state_mismatch` senza chiamate. */
export async function completeConnect(code: string, state: string): Promise<EmbedTokens> {
  const pending = readPending();
  if (!pending || pending.state !== state) throw new Error("state_mismatch");
  storageRemove("session", PENDING_KEY);
  const tokens = await tokenRequest(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: pending.clientId,
      code_verifier: pending.verifier,
      resource: `${d().origin()}/mcp`,
    },
    pending.clientId,
  );
  saveTokens(tokens);
  return tokens;
}

let refreshing: Promise<string | null> | null = null;

async function refresh(current: EmbedTokens): Promise<string | null> {
  if (!current.clientId) {
    clearTokens();
    return null;
  }
  try {
    const next = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: current.refresh, client_id: current.clientId },
      current.clientId,
    );
    saveTokens(next);
    return next.access;
  } catch (err) {
    if (err instanceof TokenError && (err.code === "invalid_grant" || err.code === "invalid_client")) {
      clearTokens();
      return null;
    }
    // Errore temporaneo (rete, server): si tiene il token finché non scade davvero.
    return current.expiresAt > d().now() ? current.access : null;
  }
}

/** Token d'accesso valido, rinnovato se mancano meno di 60 s; un solo rinnovo alla volta. */
export async function getAccessToken(): Promise<string | null> {
  if (refreshing) return refreshing;
  const tokens = loadTokens();
  if (!tokens) return null;
  if (tokens.expiresAt - d().now() >= REFRESH_MARGIN_MS) return tokens.access;
  refreshing = refresh(tokens).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

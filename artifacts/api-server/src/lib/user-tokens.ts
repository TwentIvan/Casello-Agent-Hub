// Token dell'utente per le run in corso o in pausa: SOLO in memoria, mai nel DB né nei log.
// Scadono dopo PAUSE_TTL_MS (la durata massima di una pausa): se il processo si riavvia o
// la pausa dura troppo, la ripresa deve riportare il token.

export const PAUSE_TTL_MS = 600_000;

interface Entry {
  token: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const tokens = new Map<number, Entry>();

export function setUserToken(runId: number, token: string): void {
  clearUserToken(runId);
  const timer = setTimeout(() => tokens.delete(runId), PAUSE_TTL_MS);
  // Il timer non tiene in vita il processo
  timer.unref();
  tokens.set(runId, { token, expiresAt: Date.now() + PAUSE_TTL_MS, timer });
}

export function getUserToken(runId: number): string | undefined {
  const entry = tokens.get(runId);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    clearUserToken(runId);
    return undefined;
  }
  return entry.token;
}

export function clearUserToken(runId: number): void {
  const entry = tokens.get(runId);
  if (!entry) return;
  clearTimeout(entry.timer);
  tokens.delete(runId);
}

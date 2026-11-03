// Token dell'utente per le run in corso: SOLO in memoria, mai nel DB né nei log.
// Vive per la durata della run: chi la conclude (fine, errore, annullamento) lo cancella.

const tokens = new Map<number, string>();

export function setUserToken(runId: number, token: string): void {
  tokens.set(runId, token);
}

export function getUserToken(runId: number): string | undefined {
  return tokens.get(runId);
}

export function clearUserToken(runId: number): void {
  tokens.delete(runId);
}

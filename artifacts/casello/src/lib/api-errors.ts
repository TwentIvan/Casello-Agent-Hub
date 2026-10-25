import { ApiError } from "@workspace/api-client-react";

/** Messaggio leggibile per un errore delle chiamate API (per toast e form). */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const data = error.data as { error?: unknown } | null;
    if (data && typeof data.error === "string") return data.error;
    if (error.status === 429) return "Troppe richieste: riprova tra poco.";
    return `Errore del server (${error.status}).`;
  }
  return "Impossibile contattare l'API.";
}

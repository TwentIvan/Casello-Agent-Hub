// Pulsanti d'invio del pannello delle chat (logica pura, provata con Vitest).

export type SendMode = "normal" | "now" | "queue";
export type SendAction = "send" | "now" | "queue";

/**
 * Pulsanti d'invio attivi: a turno fermo «Scrivi a …» (`send`); durante il turno «Invia subito» (`now`, ferma il turno e
 * manda il testo appena si ferma) e «Accoda» (`queue`, parte a fine turno). In sola lettura o col testo vuoto nessuno.
 */
export function sendActions(state: { running: boolean; readOnly: boolean; empty: boolean; interruptible?: boolean }): SendAction[] {
  if (state.readOnly || state.empty) return [];
  // Chat senza «Ferma» né coda (Responsabile di Botcave): durante il turno non si invia
  if (state.running && state.interruptible === false) return [];
  return state.running ? ["now", "queue"] : ["send"];
}

/** Modo dell'invio verso il server per il pulsante. */
export function sendModeOf(action: SendAction): SendMode {
  return action === "send" ? "normal" : action;
}

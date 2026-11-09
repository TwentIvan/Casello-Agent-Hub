// Turni delegati al nodo: codici d'errore chiusi riferiti dal nodo e messaggi fissi verso l'utente (spec §6).
// Il testo di `claude` non arriva mai all'utente né nei log: solo questi messaggi.

export const NODE_TURN_ERROR_CODES = [
  "model_unavailable",
  "timeout",
  "usage_limit",
  "not_logged_in",
  "claude_failed",
  "stopped",
  "lease_lost",
  "node_disabled",
  "restart",
] as const;

export type NodeTurnErrorCode = (typeof NODE_TURN_ERROR_CODES)[number];

export const NODE_TURN_MESSAGES = {
  offline: (nodeName: string) => `Il nodo «${nodeName}» è offline: accendilo o scegli un altro modello`,
  nodeDeleted: "Il nodo di Claude Code è stato eliminato: scegli un altro modello",
  usageLimit: "Claude Code ha raggiunto il limite d'uso del tuo account: riprova più tardi",
  notLoggedIn: "Claude Code non ha fatto l'accesso sul nodo: esegui claude e accedi",
  modelUnavailable: "Il modello non è disponibile per il tuo account Claude",
  timeout: "Claude Code non ha risposto in tempo",
  leaseLost: "Il nodo non è più raggiungibile",
  stopped: "Esecuzione interrotta sul nodo",
  restart: "Turno interrotto dal riavvio",
  claudeFailed: "Claude Code non è riuscito a completare il turno",
} as const;

/** Codice riferito dal nodo: uno dell'elenco, altrimenti `claude_failed`. */
export function normalizeErrorCode(value: unknown): NodeTurnErrorCode {
  return (NODE_TURN_ERROR_CODES as readonly unknown[]).includes(value) ? (value as NodeTurnErrorCode) : "claude_failed";
}

/** Messaggio fisso di un turno fallito con questo codice (`expired` e nodo non pronto hanno `offline`). */
export function nodeTurnErrorMessage(code: NodeTurnErrorCode | null): string {
  switch (code) {
    case "usage_limit":
      return NODE_TURN_MESSAGES.usageLimit;
    case "not_logged_in":
      return NODE_TURN_MESSAGES.notLoggedIn;
    case "model_unavailable":
      return NODE_TURN_MESSAGES.modelUnavailable;
    case "timeout":
      return NODE_TURN_MESSAGES.timeout;
    case "lease_lost":
      return NODE_TURN_MESSAGES.leaseLost;
    case "stopped":
    case "node_disabled":
      return NODE_TURN_MESSAGES.stopped;
    case "restart":
      return NODE_TURN_MESSAGES.restart;
    default:
      return NODE_TURN_MESSAGES.claudeFailed;
  }
}

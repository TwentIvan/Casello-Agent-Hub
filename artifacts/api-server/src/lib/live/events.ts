// Canale degli aggiornamenti in tempo reale delle run (issue #108): chi scrive lo stato o i passi di una run
// pubblica qui un avviso, il flusso `/api/live` lo inoltra alla console, che ricarica solo ciò che è cambiato.
// In memoria e nello stesso processo: con più container (deploy) gli avvisi dell'altro non arrivano e la console
// ricade sul polling lento. L'avviso porta solo id, mai input, output o argomenti.

export type RunChange = {
  runId: number;
  /** Null quando chi scrive non lo conosce (es. esito di un tool `ui`): la console ricarica comunque. */
  agentId: number | null;
};

type Listener = (change: RunChange) => void;

const listeners = new Set<Listener>();

/** Avvisa gli ascoltatori che la run è cambiata (stato o passi). Non lancia mai. */
export function publishRunChange(runId: number, agentId: number | null): void {
  for (const listener of listeners) {
    try {
      listener({ runId, agentId });
    } catch {
      // Un ascoltatore guasto non ferma gli altri né chi scrive la run
    }
  }
}

/** Registra un ascoltatore; restituisce la funzione che lo toglie. */
export function subscribeRunChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Numero di ascoltatori registrati (per i test). */
export function runChangeListenerCount(): number {
  return listeners.size;
}

/**
 * Raccoglie gli avvisi e li consegna a gruppi, al più uno ogni `windowMs`: una run che scrive molti passi di fila
 * produce un solo messaggio. Le run si ripetono una volta sola per gruppo.
 */
export function createRunChangeBatcher(deliver: (changes: RunChange[]) => void, windowMs: number) {
  const pending = new Map<number, RunChange>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (pending.size === 0) return;
    const changes = [...pending.values()];
    pending.clear();
    deliver(changes);
  };
  return {
    push(change: RunChange) {
      const known = pending.get(change.runId);
      // Un agente noto non si perde se un avviso dopo non lo conosce
      pending.set(change.runId, { runId: change.runId, agentId: change.agentId ?? known?.agentId ?? null });
      if (!timer) timer = setTimeout(flush, windowMs);
    },
    flush,
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

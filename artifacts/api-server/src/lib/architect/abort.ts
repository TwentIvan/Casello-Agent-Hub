// Annullamento delle analisi cloud: un AbortController per ogni analisi che gira in questo processo.
// `abortAnalysis` interrompe la chiamata al modello in corso; l'analisi si chiude da sola `failed`.

const controllers = new Map<number, AbortController>();

/** Registra l'analisi e restituisce il segnale che la ferma. */
export function registerAnalysisAbort(id: number): AbortSignal {
  const controller = new AbortController();
  controllers.set(id, controller);
  return controller.signal;
}

/** Ferma l'analisi; true se gira in questo processo. */
export function abortAnalysis(id: number): boolean {
  const controller = controllers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Toglie l'analisi dal registro (a fine esecuzione). */
export function releaseAnalysisAbort(id: number): void {
  controllers.delete(id);
}

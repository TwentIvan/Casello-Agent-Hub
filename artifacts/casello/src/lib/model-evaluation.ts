// Testi della carta «Valutazione del modello» nella scheda agente (issue #112): funzioni pure.

/** Tasso di successo (0..1) in percentuale intera: «83 %»; «n.d.» senza run. */
export function formatRate(rate: number | null): string {
  return rate === null ? "n.d." : `${Math.round(rate * 100)} %`;
}

/** Riga del successo osservato di un suggerimento: provato dall'agente o confronto solo sui prezzi. */
export function evidenceLabel(observedRuns: number, observedSuccessRate: number | null): string {
  if (observedRuns === 0) return "mai provato con questo agente: confronto sui prezzi";
  const runs = observedRuns === 1 ? "1 run" : `${observedRuns} run`;
  return `provato in ${runs}, successo ${formatRate(observedSuccessRate)}`;
}

/** Errori dei tool sulle chiamate: «2 su 40»; «nessuna chiamata» senza chiamate. */
export function toolErrorsLabel(toolCalls: number, toolErrors: number): string {
  return toolCalls === 0 ? "nessuna chiamata" : `${toolErrors} su ${toolCalls}`;
}

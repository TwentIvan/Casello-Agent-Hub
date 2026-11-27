// Esiti del collaudo e decisione della correzione automatica: funzioni pure

/** Esito come lo scrive il database. */
export type DbOutcome = "ok" | "problems" | "not_startable";

/** Esito come lo riferisce il runner (lingua dell'utente). */
export type DeliveredOutcome = "ok" | "problemi" | "non_avviabile";

export type AutoFixDecision = "reject" | "keep" | "keep_exhausted";

/** Numero massimo di rifiuti automatici di una stessa voce. */
export const MAX_AUTO_REJECTS = 2;

export function toDbOutcome(outcome: DeliveredOutcome): DbOutcome {
  if (outcome === "problemi") return "problems";
  if (outcome === "non_avviabile") return "not_startable";
  return "ok";
}

/**
 * Decide cosa fare di una voce dopo un collaudo.
 * - `reject`: esito negativo, correzione automatica attiva, meno di due rifiuti, voce ancora in attesa.
 * - `keep_exhausted`: esito negativo con correzione automatica attiva ma già esaurita.
 * - `keep`: nessuna azione automatica.
 */
export function autoFixDecision(input: {
  outcome: DbOutcome;
  autoFix: boolean;
  autoRejects: number;
  itemPending: boolean;
}): AutoFixDecision {
  const negative = input.outcome !== "ok";
  if (!negative || !input.autoFix || !input.itemPending) return "keep";
  return input.autoRejects < MAX_AUTO_REJECTS ? "reject" : "keep_exhausted";
}

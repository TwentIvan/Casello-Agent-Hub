// Messaggi fissi del ciclo di evoluzione automatica: mai testo di GitHub, dei modelli o del DB.
export const EVOLUTION_MESSAGES = {
  consentInvalid: "consenso non valido",
  consentRenew: "consenso da rinnovare",
  modeUnavailable: "modalità non ancora disponibile",
  noCode: "l'app non ha il codice collegato tramite l'App GitHub",
  noAccess: "accesso al repository non disponibile",
  budgetReached: "tetto di spesa del ciclo raggiunto",
  stoppedByUser: "fermato dall'utente",
  tooManyErrors: "troppi errori di fila: controlla e riprendi",
  noNewItems: "nessuna voce nuova",
  restartInterrupted: "giro interrotto dal riavvio",
  analysisStopped: "analisi fermata dall'utente",
  notFound: "ciclo non trovato",
  roundRunning: "un giro è già in corso",
  paused: "il ciclo è in pausa",
  stopBeforeDelete: "ferma il ciclo prima di eliminarlo",
  waitingArchitecture: "in attesa della sintesi dell'architettura",
  appNotFound: "App non trovata",
  invalidSettings: "impostazioni del ciclo non valide",
  templateUnavailable: "modello di squadra non disponibile",
  tooManyRuns: "Troppe richieste: riprova tra poco",
  analysisBusy: "c'è già un'analisi in corso per questa app: riprova quando finisce",
} as const;

/** Esito di un giro che ha approvato `n` voci. */
export function roundOutcome(n: number): string {
  return n === 1
    ? "1 voce approvata: usa Implementa per farla realizzare"
    : `${n} voci approvate: usa Implementa per farle realizzare`;
}

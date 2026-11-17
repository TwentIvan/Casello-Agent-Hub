// Messaggi fissi del ciclo di evoluzione automatica: mai testo di GitHub, dei modelli o del DB.
export const EVOLUTION_MESSAGES = {
  consentInvalid: "consenso non valido",
  consentRenew: "consenso da rinnovare",
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
  notPayer: "solo chi ha attivato il ciclo può avviare un giro",
  analysisBusy: "c'è già un'analisi in corso per questa app: riprova quando finisce",
  templateNoCode: "il modello di squadra deve avere un ruolo che scrive codice",
  workOpen: "il lavoro della squadra del ciclo non è ancora chiuso",
  roundExpired: "giro scaduto",
  nothingCompleted: "nessuna voce completata",
  cyclePaused: "ciclo di evoluzione fermato",
  teamBudgetFromCycle: "il tetto della squadra del ciclo si cambia nelle impostazioni del ciclo",
  resumeRequest: "Il ciclo di evoluzione è ripreso: riprendi il lavoro.",
} as const;

/** Esito di un giro in implementazione con `n` voci affidate alla squadra del ciclo. */
export function implementingOutcome(n: number): string {
  return n === 1 ? "1 voce approvata: affidata alla squadra del ciclo" : `${n} voci approvate: affidate alla squadra del ciclo`;
}

/** Esito del giro quando il lavoro è in prova e aspetta «Porta in produzione». */
export function awaitingReleaseOutcome(work: number): string {
  return `lavoro ${work} in prova: Porta in produzione da decidere`;
}

/** Esito del giro quando il lavoro è in produzione. */
export function releasedOutcome(work: number): string {
  return `lavoro ${work} in produzione`;
}

/** Esito di un giro che ha approvato `n` voci. */
export function roundOutcome(n: number): string {
  return n === 1
    ? "1 voce approvata: usa Implementa per farla realizzare"
    : `${n} voci approvate: usa Implementa per farle realizzare`;
}

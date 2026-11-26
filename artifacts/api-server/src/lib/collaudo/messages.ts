// Messaggi fissi del collaudo dei lavori: mai testo di GitHub, del modello o del DB

export const COLLAUDO_MESSAGES = {
  notConfigured: "Collaudo non configurato: preparalo in Account (una volta sola)",
  noModel: "il capo non ha un modello cloud per il collaudo",
  nodeNoFallback:
    "il capo usa Claude Code (nodo) senza ripiego cloud: il collaudo serve un modello cloud",
  runnerNotStarted: "runner non partito entro 15 minuti",
  timeout: "tempo del collaudo scaduto",
  interrupted: "collaudo interrotto",
  notDelivered: "collaudo non consegnato",
  internalError: "errore interno nel collaudo",
  autoFixExhausted: "2 correzioni automatiche non sono bastate",
  invalidRecipe: (detail: string) => `ricetta non valida: ${detail}`,
  dispatchFailed:
    "lancio del collaudo non riuscito: controlla il repository di collaudo in Account",
} as const;

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
  noReport: "collaudo concluso senza resoconto",
  autoRejectTurn: (work: number, note: string) =>
    `Il collaudo del lavoro ${work} ha trovato problemi: correggi e richiudi il lavoro. Resoconto: ${note}`,
  userRejectTurn: (work: number, note: string) =>
    `L'utente ha rimandato il lavoro ${work} alla squadra dopo il collaudo: correggi e richiudi il lavoro. Resoconto: ${note}`,
  autoFixExhausted: "2 correzioni automatiche non sono bastate",
  invalidRecipe: (detail: string) => `ricetta non valida: ${detail}`,
  dispatchFailed:
    "lancio del collaudo non riuscito: controlla il repository di collaudo in Account",
} as const;

/** Messaggi delle route pubbliche del collaudo (`/api/release-tests`, ricetta e configurazione). */
export const RELEASE_TEST_ROUTE_MESSAGES = {
  testNotFound: "collaudo non trovato",
  fileNotFound: "file non trovato",
  appNotFound: "App non trovata",
  needFilter: "indica workId o appId",
  itemNotFound: "voce «Porta in produzione» non trovata",
  relightNotDone: "il collaudo non è concluso: aspetta la fine",
  itemNotPending: "la voce «Porta in produzione» non è più in attesa",
  relightFailed: "un collaudo è in corso per questa App: riprova quando finisce",
  relightNotLatest: "«Riaccendi» vale solo per l'ultimo collaudo del lavoro",
  relightLimit: "limite di «Riaccendi» di oggi raggiunto: riprova domani",
  sendBackGone: "la voce «Porta in produzione» è già stata decisa",
} as const;

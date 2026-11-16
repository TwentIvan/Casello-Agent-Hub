/** Testi fissi dello strumento `cerca_best_practice` (mai il testo di Gemini né del DB). */
export const BEST_PRACTICE_MESSAGES = {
  noSearchModel: "nessun modello Gemini per la ricerca: sceglilo in Account → Personaggi, intanto usa le fonti curate",
  modelUnavailable: "il modello Gemini per la ricerca non è usabile: controllalo in Account → Personaggi",
  keyRejected: "chiave Gemini rifiutata: controlla l'account in Account",
  rateLimitedGemini: "limite di richieste di Gemini raggiunto: riprova tra poco",
  unreachable: "Gemini non raggiungibile o tempo scaduto: riprova più tardi",
  empty: "la ricerca non ha prodotto una risposta: riformula la domanda",
  tooManyInTurn: "troppe ricerche in questo turno: usa quanto hai già trovato",
  rateLimited: "troppe ricerche al minuto: riprova tra poco",
  invalidQuestion: "domanda non valida: da 3 a 300 caratteri",
  internal: "ricerca non riuscita: riprova più tardi",
  analysisNoQuestions: "il modello dell'analisi non ha proposto domande valide",
  analysisModelFailed: "chiamata al modello dell'analisi non riuscita",
  analysisLimit: "tetto di token o tempo dell'analisi raggiunto",
} as const;

/** Costo stimato (prudente) di una query di ricerca Google di Gemini, in USD. */
export const GROUNDING_QUERY_USD = 0.014;

/** Una ricerca uguale dello stesso utente entro 7 giorni si risponde dalla cache. */
export const BEST_PRACTICE_CACHE_MS = 7 * 24 * 3600_000;

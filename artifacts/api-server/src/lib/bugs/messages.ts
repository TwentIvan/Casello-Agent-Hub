import type { BugReportRow } from "@workspace/db";

export type BugReportStatus = BugReportRow["status"];

// Messaggi fissi delle segnalazioni dei bug: mai testo dell'utente né del DB.
export const BUG_MESSAGES = {
  unavailable: "segnalazioni non disponibili",
  dailyLimit: "limite di segnalazioni di oggi raggiunto: riprova domani",
  notFound: "segnalazione non trovata",
  notWaiting: "la segnalazione non aspetta una risposta",
  invalidText: "testo non valido",
  noBugTeam: "nessuna squadra per i bug attiva per questa App",
  bugTeamTaken: (name: string) => `l'App ha già una squadra per i bug: ${name}`,
  notClosable: "segnalazione già chiusa",
  triageInconclusive: "vaglio non concluso: decidi tu",
  fixedMessage: "Corretta: la correzione è stata unita e sarà disponibile con il prossimo aggiornamento dell'app.",
  rejectedDefault: "Segnalazione non accolta.",
  invalidBrowserKey: "chiave del browser non valida",
  tooMany: "Troppe richieste: riprova tra poco",
} as const;

// Frasi per l'utente: uguali in API e console
export const BUG_STATUS_LABELS: Record<BugReportStatus, string> = {
  received: "In esame",
  triage: "In esame",
  needs_info: "Serve una tua risposta",
  pending_approval: "In attesa di approvazione",
  in_progress: "In lavorazione",
  fixed: "Corretta",
  not_a_bug: "Non è un problema",
  duplicate: "Già segnalata",
  rejected: "Non accolta",
};

export const BUG_LIMITS = {
  title: 200,
  description: 4000,
  steps: 4000,
  expected: 2000,
  message: 4000,
  publicMessage: 1000,
  rejectNote: 500,
  summary: 1000,
  question: 1000,
  userMessage: 500,
  perRequesterPerDay: 5,
  perIpPerHour: 10,
  perIpPerMinute: 60,
  perReportMessagesPerHour: 20,
  maxQuestionRounds: 3,
  listMax: 50,
  bodyBytes: 32 * 1024,
  pageUrl: 500,
} as const;

export class BugError extends Error {
  constructor(
    public status: 400 | 401 | 404 | 409 | 413 | 429,
    message: string,
  ) {
    super(message);
    this.name = "BugError";
  }
}

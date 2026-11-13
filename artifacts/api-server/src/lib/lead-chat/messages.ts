// Messaggi fissi della chat con il Responsabile di Botcave: mai testo del modello o del DB.

export const LEAD_CHAT_MESSAGES = {
  noApp: "Botcave non è registrata come App",
  inactive: "il Responsabile di Botcave non è attivo",
  noModel: "scegli per il Responsabile un modello di uno dei tuoi account AI",
  changed: "il Responsabile è cambiato: apri una nuova conversazione",
  notFound: "conversazione non trovata",
  archived: "conversazione archiviata",
  busy: "il Responsabile sta già rispondendo",
  empty: "messaggio vuoto",
  tooLong: "messaggio troppo lungo: al massimo 4000 caratteri",
  badPage: "contesto della pagina non valido",
  tooMany: "Troppe richieste: riprova tra poco",
  tooManyConversations: "troppe conversazioni: eliminane qualcuna",
  queueFull: "troppe run in attesa per il Responsabile",
  gone: "risposta non più disponibile",
} as const;

/** Errore con stato HTTP: le route lo traducono direttamente in `{error}`. */
export class LeadChatError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LeadChatError";
    this.status = status;
  }
}

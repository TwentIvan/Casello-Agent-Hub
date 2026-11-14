// Messaggi fissi della chat con Barbara, la Responsabile di Botcave (agente `general` dell'App `casello`): mai testo del modello o del DB.

export const LEAD_CHAT_MESSAGES = {
  noApp: "Botcave non è registrata come App",
  inactive: "Barbara, la Responsabile di Botcave, non è attiva",
  noModel: "scegli per Barbara un modello di uno dei tuoi account AI",
  changed: "la Responsabile è cambiata: apri una nuova conversazione",
  notFound: "conversazione non trovata",
  archived: "conversazione archiviata",
  busy: "Barbara sta già rispondendo",
  empty: "messaggio vuoto",
  tooLong: "messaggio troppo lungo: al massimo 4000 caratteri",
  badPage: "contesto della pagina non valido",
  tooMany: "Troppe richieste: riprova tra poco",
  tooManyConversations: "troppe conversazioni: eliminane qualcuna",
  queueFull: "troppe run in attesa per Barbara",
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

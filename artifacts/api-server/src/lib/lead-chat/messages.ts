// Messaggi fissi della chat con il Responsabile di un'App (agente `general`; per l'App `casello` Barbara, la Responsabile di
// Botcave): mai testo del modello o del DB.

export const LEAD_CHAT_MESSAGES = {
  noApp: "Botcave non è registrata come App",
  appNotFound: "App non trovata",
  actionNotFound: "azione non trovata: ricarica il pannello",
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

/**
 * Testi che nominano il Responsabile. Per l'App `casello` con «Barbara» restano quelli di sempre, con «la Responsabile di
 * Botcave»; altrimenti (anche un'altra App il cui Responsabile si chiama «Barbara») sono neutri, col nome.
 */
export function leadChatMessages(name: string, isCasello: boolean) {
  if (isCasello && name === "Barbara") {
    return {
      inactive: LEAD_CHAT_MESSAGES.inactive,
      noModel: LEAD_CHAT_MESSAGES.noModel,
      busy: LEAD_CHAT_MESSAGES.busy,
      queueFull: LEAD_CHAT_MESSAGES.queueFull,
    };
  }
  return {
    inactive: `${name} non è attivo`,
    noModel: `scegli per ${name} un modello di uno dei tuoi account AI`,
    busy: `${name} sta già rispondendo`,
    queueFull: `troppe run in attesa per ${name}`,
  };
}

/** Errore con stato HTTP: le route lo traducono direttamente in `{error}`. */
export class LeadChatError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LeadChatError";
    this.status = status;
  }
}

/** Messaggi fissi della creazione di una nuova App da zero (mai testo di GitHub o del DB). */
export const APP_BOOTSTRAP_MESSAGES = {
  slugTaken: (slug: string) => `lo slug ${slug} è già usato da un'altra App`,
  slugInvalid: "slug non valido: minuscole, cifre e trattini, al più 64 caratteri",
  slugReserved: "lo slug casello è riservato",
  nameInvalid: "nome obbligatorio, al più 80 caratteri",
  domainInvalid: "dominio non valido",
  domainTaken: "il dominio è già usato da un'altra App",
  briefInvalid: "brief obbligatorio, al più 20 000 caratteri",
  briefCredential: "il brief sembra contenere una credenziale: toglila",
  repoMismatch: "il repository deve chiamarsi come lo slug",
  requestOpen: "c'è già una richiesta aperta per questo slug o repository",
  notVisible: "l'App GitHub non vede il repository: aggiungilo all'installazione",
  notFromTemplate: "il repository non è nato dal modello",
  notFresh: "il repository non è più quello appena creato: ricrealo dal modello",
  tooManyFiles: "il modello ha troppi file da personalizzare",
  githubUnavailable: "GitHub non raggiungibile: riprova",
  interrupted: "interrotto dal riavvio: usa Riprova",
  notRetryable: "la richiesta non è da riprendere",
  notFound: "richiesta non trovata",
  itemNotManual: "voce verificata da Botcave: non si segna a mano",
  /** Il testo del tetto di spesa si passa così com'è. */
  budget: (text: string) => text,
} as const;

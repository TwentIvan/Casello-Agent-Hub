// Messaggi fissi della sintesi dell'architettura delle App: mai il testo di GitHub, del modello o del DB.

export const ARCH_MESSAGES = {
  noAccess: "accesso al repository non disponibile",
  invalid: "sintesi non valida",
  notDelivered: "sintesi non consegnata",
  interrupted: "generazione interrotta dal riavvio",
  budgetWait: "in attesa: tetto di spesa raggiunto",
  nodeNoFallback: "Claude Code (nodo) non genera la sintesi: imposta un ripiego cloud",
  githubDown: "GitHub non raggiungibile",
  notAvailable: (app: string) => `architettura non ancora disponibile per ${app}`,
  appNotFound: "app non trovata",
  versionNotFound: "versione non trovata",
  tooMany: "Troppe richieste: riprova tra poco",
  running: "sintesi già in corso",
  noGithub: "collega il repository tramite l'App GitHub",
  noLead: "il Responsabile dell'app non ha un modello",
  invalidPart: "parte non valida: usa sintesi o mappa",
  toolFailed: "lettura dell'architettura non riuscita: riprova più tardi",
  internal: "generazione non riuscita: riprova più tardi",
} as const;

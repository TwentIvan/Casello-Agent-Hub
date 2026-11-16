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
  running: "sintesi già in corso",
  noGithub: "collega il repository tramite l'App GitHub",
  noLead: "il Responsabile dell'app non ha un modello",
  internal: "generazione non riuscita: riprova più tardi",
} as const;

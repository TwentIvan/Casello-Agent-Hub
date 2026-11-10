// Messaggi fissi della lettura del codice delle app: mai il testo di GitHub.

export const CODE_MESSAGES = {
  unavailable: (app: string) => `codice non disponibile per ${app}: collega il repository GitHub`,
  noAccess: (app: string) => `non hai accesso al repository di ${app}`,
  notConfigured: "GitHub non è configurato",
  revoked: "accesso al repository revocato",
  notFound: "repository o branch non trovato",
  unreachable: "GitHub non raggiungibile: riprova tra poco",
  appNotFound: (slug: string) => `app non trovata: ${slug}`,
  needApp: "indica l'app con il suo slug",
  internal: "errore interno dello strumento",
} as const;

/**
 * Messaggi fissi di Git per i compiti con codice (spec §4.5) e relativo errore. In un file a parte perché li usano sia
 * `client.ts` (409 «accesso al repository non disponibile») sia `git-workspace.ts`, senza import circolari.
 */
export const GIT_MESSAGES = {
  notInstalled: "Git non installato sul Mac: apri Botcave Nodo e scegli Installa Git",
  noAccess: "accesso al repository non disponibile",
  unreachable: "repository non raggiungibile: riprova più tardi",
  baseMissing: "branch base non trovato: controlla il branch dell'App in Botcave",
  pushChanged: "push non riuscito: il branch è cambiato su GitHub",
  pushRefused: "push non riuscito: GitHub ha rifiutato le modifiche",
  pushRetry: "push non riuscito: riprova più tardi",
  prepareFailed: "preparazione del repository non riuscita",
} as const;

/** Errore della preparazione o della pubblicazione: il messaggio è sempre uno di `GIT_MESSAGES`. */
export class GitWorkspaceError extends Error {
  constructor(
    readonly status: "blocked" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "GitWorkspaceError";
  }
}

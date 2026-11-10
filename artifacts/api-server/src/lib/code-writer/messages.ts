/** Messaggi fissi del codice scritto dai ruoli delle squadre: mai testo di GitHub, contenuti o token. */
export const CODE_WRITE_MESSAGES = {
  permission: (name: string) =>
    `l'App GitHub non ha il permesso ${name} su questo repository: accetta i nuovi permessi nell'installazione`,
  branchMoved: "il branch è cambiato: rileggi i file prima di committare",
  nothingToCommit: "nessuna modifica da committare",
  noCommits: "nessun commit da proporre: usa crea_commit",
  credential: (path: string) => `il file ${path} sembra contenere una credenziale: non lo committo`,
  workflows: "i workflow della CI non si modificano da Botcave",
  badPath: "percorso non valido",
  binary: (path: string) => `il file ${path} non è testo UTF-8 valido: i binari non si committano`,
  tooLarge: (path: string) => `il file ${path} è troppo grande`,
  tooMany: "troppi file nella copia di lavoro o nel commit",
  notFound: (path: string) => `file inesistente: ${path}`,
  textNotFound: "testo non trovato",
  textRepeated: (n: number) => `testo presente ${n} volte: allarga il contesto`,
  unavailable: "GitHub non risponde (riprova più tardi)",
  noAccess: "l'App GitHub di Botcave non ha più accesso a questo repository: reinstallala o scegli un altro repo",
} as const;

export class CodeWriteError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "CodeWriteError";
    this.status = status;
  }
}

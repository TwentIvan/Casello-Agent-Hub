// Tipi, limiti e messaggi condivisi della memoria dei personaggi (appunti e storico)

export type Character = "alfred" | "lucius";

export const NOTE_MAX_CHARS = 300;
export const NOTES_MAX = 50;
export const HISTORY_MAX = 500;
export const HISTORY_TITLE_MAX = 120;
export const HISTORY_SUMMARY_MAX = 1500;
export const HISTORY_SEARCH_MAX = 5;
export const HISTORY_LIST_MAX = 100;
export const RECENT_TITLES = 3;

export const MEMORY_MESSAGES = {
  full: "memoria piena: unisci o togli un appunto",
  credential: "non salvo credenziali in memoria",
  notFound: "appunto non trovato",
  empty: "appunto vuoto",
  tooLong: "appunto troppo lungo: al massimo 300 caratteri",
} as const;

// Errore con stato HTTP: le route lo traducono direttamente
export class MemoryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MemoryError";
    this.status = status;
  }
}

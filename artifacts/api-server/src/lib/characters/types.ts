// Errori e messaggi condivisi di Alfred e Lucius nelle aree

export const CHARACTER_MESSAGES = {
  modelUnavailable: "modello non disponibile",
} as const;

// Errore con stato HTTP: le route lo traducono direttamente
export class CharacterError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CharacterError";
    this.status = status;
  }
}

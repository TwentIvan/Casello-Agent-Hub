/** Lunghezza massima delle istruzioni personali (dopo `trimEnd`), come sul server. */
export const INSTRUCTIONS_MAX_CHARS = 8000;

/** Lunghezza del testo come la conta il server (senza gli spazi finali) e se supera il limite. */
export function instructionsCounter(text: string): { length: number; over: boolean } {
  const length = text.trimEnd().length;
  return { length, over: length > INSTRUCTIONS_MAX_CHARS };
}

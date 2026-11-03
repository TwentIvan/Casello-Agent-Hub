// Utilità di testo condivise dall'architetto.

/**
 * Primi `max` caratteri (unità UTF-16) di `text`, senza spezzare una coppia surrogata:
 * se il taglio cadrebbe tra le due metà, la coppia resta fuori.
 */
export function sliceChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Spazio lasciato, sotto il tetto dell'output di uno strumento, al suggerimento finale (es. come continuare). */
export const HINT_RESERVE_CHARS = 300;
const MAX_LOG_ARG_CHARS = 120;

/** Valore breve e su una riga per i log (percorsi, pattern, nomi scelti dal modello). */
export function logArg(value: string): string {
  const flat = value.replace(/[\r\n\t]+/g, " ");
  return flat.length > MAX_LOG_ARG_CHARS ? `${sliceChars(flat, MAX_LOG_ARG_CHARS)}…` : flat;
}

/** Testo tagliato al tetto dell'output di uno strumento, con l'indicazione del taglio. */
export function capOutput(text: string, limits: { maxToolOutputChars: number }): string {
  const max = limits.maxToolOutputChars;
  return text.length > max ? `${sliceChars(text, max)}\n[...troncato: output oltre ${max} caratteri]` : text;
}

/**
 * Quante righe, dall'inizio, entrano nel tetto dell'output lasciando spazio a un suggerimento finale:
 * si taglia prima di aggiungere il suggerimento, così il suggerimento non viene mai troncato.
 */
export function fittingLines(lines: string[], limits: { maxToolOutputChars: number }): number {
  const limit = limits.maxToolOutputChars - HINT_RESERVE_CHARS;
  let chars = 0;
  for (let i = 0; i < lines.length; i++) {
    chars += lines[i]!.length + 1;
    if (chars > limit) return i;
  }
  return lines.length;
}

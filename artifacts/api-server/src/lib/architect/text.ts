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

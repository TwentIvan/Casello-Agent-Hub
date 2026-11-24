// Allegati nelle chat (issue #120): funzioni pure del campo di scrittura (controllo dei file prima del caricamento,
// corpo del messaggio, dimensioni). Le regole vere sono del server.

/** Tipi ammessi (il server li riconosce dai primi byte). */
export const CHAT_ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"] as const;
/** Valore di `accept` del selettore dei file. */
export const CHAT_ATTACHMENT_ACCEPT = ".png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf";
export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("it-IT", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("it-IT", { maximumFractionDigits: 1 })} MB`;
}

/** Motivo per cui il file non si allega, o null. `already` = allegati già pronti per il messaggio. */
export function attachmentFileError(file: { name: string; type: string; size: number }, already: number): string | null {
  if (already >= MAX_ATTACHMENTS_PER_MESSAGE) return `Al massimo ${MAX_ATTACHMENTS_PER_MESSAGE} allegati per messaggio`;
  if (!(CHAT_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return `«${file.name}»: allega immagini PNG, JPEG o WebP oppure PDF`;
  if (file.size === 0) return `«${file.name}» è vuoto`;
  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
    return `«${file.name}» pesa ${formatBytes(file.size)}: il massimo è ${formatBytes(MAX_CHAT_ATTACHMENT_BYTES)} per file`;
  }
  return null;
}

/** Corpo del messaggio: il modo solo se diverso da `normal`, gli allegati solo se ci sono (sempre a turno fermo). */
export function messageBody(
  content: string,
  mode?: "normal" | "now" | "queue",
  attachmentIds?: number[],
): { content: string; mode?: "now" | "queue"; attachmentIds?: number[] } {
  if (attachmentIds && attachmentIds.length > 0) return { content, attachmentIds };
  return mode && mode !== "normal" ? { content, mode } : { content };
}

/** Con allegati pronti si manda solo a turno fermo (niente coda né «Invia subito»). */
export function attachmentsBlockSend(pending: number, running: boolean): boolean {
  return pending > 0 && running;
}

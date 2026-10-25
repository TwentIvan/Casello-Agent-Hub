/** Lettura limitata del corpo di una risposta HTTP, condivisa da esecutore dei tool e sorgenti dell'architetto. */

/** Il corpo supera il limite di byte consentito. */
export class BodyTooLarge extends Error {}

/**
 * Legge il corpo a flusso, interrompendo appena supera `maxBytes` (controlla prima il
 * content-length dichiarato): una risposta ostile non può esaurire la memoria.
 */
export async function readBytesLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new BodyTooLarge();
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

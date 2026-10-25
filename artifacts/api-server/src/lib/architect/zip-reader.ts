import { Inflate } from "fflate";

/**
 * Lettore zip minimale per archivi non attendibili.
 * Non usa `unzipSync` di fflate: lì le dimensioni dichiarate non vincolano né la copia né la
 * decompressione, e voci sovrapposte moltiplicano memoria e CPU. Qui l'intera struttura viene
 * validata (nessuna sovrapposizione, niente zip64, niente cifratura) prima di leggere un solo byte
 * di dati, e la decompressione è in streaming con tetto sull'output.
 */

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

export interface RawZipEntry {
  name: string;
  method: 0 | 8;
  compressedSize: number;
  originalSize: number;
  /** Inizio dei dati compressi nell'archivio. */
  dataStart: number;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const INFLATE_CHUNK = 8192;

/** Elenca e valida le voci. Lancia ZipFormatError con messaggio in italiano. */
export function readZipEntries(bytes: Uint8Array, maxEntries: number): RawZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  const invalid = () => new ZipFormatError("L'archivio non è uno zip valido.");

  // End Of Central Directory: ultimi 22 byte + commento (max 65 535).
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 22 - 0xffff); i--) {
    // Solo un EOCD che chiude davvero l'archivio (un finto EOCD nel commento non vale).
    if (view.getUint32(i, true) === EOCD_SIG && i + 22 + view.getUint16(i + 20, true) === len) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalid();
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIG) {
    throw new ZipFormatError("archivio zip64 non supportato");
  }
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipFormatError("archivio zip64 non supportato");
  }
  if (count > maxEntries) {
    throw new ZipFormatError(`L'archivio contiene troppe voci: limite di ${maxEntries}.`);
  }
  if (cdOffset + cdSize > eocd) throw invalid();

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: RawZipEntry[] = [];
  const ranges: [number, number][] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > len || view.getUint32(p, true) !== CD_SIG) throw invalid();
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const originalSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (p + 46 + nameLen + extraLen + commentLen > cdOffset + cdSize) throw invalid();
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x41) throw new ZipFormatError("L'archivio contiene voci cifrate.");
    if (method !== 0 && method !== 8) {
      throw new ZipFormatError("L'archivio usa un metodo di compressione non supportato.");
    }
    if (compressedSize === 0xffffffff || originalSize === 0xffffffff) {
      throw new ZipFormatError("archivio zip64 non supportato");
    }
    if (compressedSize > len) {
      throw new ZipFormatError("L'archivio è corrotto: dimensione compressa incoerente.");
    }
    if (method === 0 && compressedSize !== originalSize) {
      throw new ZipFormatError("L'archivio è corrotto: dimensioni incoerenti.");
    }
    if (localOffset + 30 > len || view.getUint32(localOffset, true) !== LOCAL_SIG) throw invalid();
    const dataStart =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > len) throw invalid();
    ranges.push([localOffset, dataEnd]);
    entries.push({ name, method, compressedSize, originalSize, dataStart });
  }

  // Nessuna sovrapposizione (comprese due voci con lo stesso header locale).
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]![0] < ranges[i - 1]![1]) {
      throw new ZipFormatError("L'archivio è corrotto: voci sovrapposte.");
    }
  }
  return entries;
}

/**
 * Estrae una voce già validata, producendo esattamente `originalSize` byte.
 * Lancia ZipFormatError se l'output reale diverge da quello dichiarato; l'inflate si interrompe
 * appena l'output supera il dichiarato. Per i dati compressi si spinge a blocchi piccoli, così
 * l'output di una singola `push` resta limitato (~1 000:1 sul blocco).
 */
export function extractEntry(bytes: Uint8Array, entry: RawZipEntry): Uint8Array {
  const raw = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return raw.slice();

  const out = new Uint8Array(entry.originalSize);
  let written = 0;
  const overflow = new ZipFormatError("L'archivio è corrotto: dimensione reale diversa da quella dichiarata.");
  try {
    const inflate = new Inflate((chunk) => {
      if (written + chunk.length > out.length) throw overflow;
      out.set(chunk, written);
      written += chunk.length;
    });
    if (raw.length === 0) inflate.push(raw, true);
    for (let i = 0; i < raw.length; i += INFLATE_CHUNK) {
      inflate.push(raw.subarray(i, i + INFLATE_CHUNK), i + INFLATE_CHUNK >= raw.length);
    }
  } catch (e) {
    if (e === overflow) throw e;
    throw new ZipFormatError("L'archivio è corrotto: dati compressi non validi.");
  }
  if (written !== out.length) throw overflow;
  return out;
}

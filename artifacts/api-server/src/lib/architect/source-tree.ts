import { unzipSync } from "fflate";

/**
 * Vista in memoria, con limiti di dimensione, del sorgente di un'app ricavata da uno zip.
 * L'archivio è input non attendibile: niente accesso al disco, percorsi pericolosi scartati,
 * dimensioni controllate prima di decomprimere.
 */

export const SOURCE_LIMITS = {
  maxZipBytes: 52_428_800,
  maxFileBytes: 262_144,
  maxFiles: 5_000,
  maxTotalBytes: 62_914_560,
  maxReadLines: 400,
  maxReadChars: 24_000,
  maxSearchResults: 100,
} as const;

/** Somma delle dimensioni dichiarate oltre la quale l'archivio è rifiutato subito. */
const MAX_DECLARED_TOTAL_BYTES = SOURCE_LIMITS.maxTotalBytes * 10;
const MAX_LIST_DEPTH = 5;
const MAX_SEARCH_TEXT_CHARS = 200;
const BINARY_SNIFF_BYTES = 8192;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  ".turbo",
  ".cache",
]);

const BINARY_EXTENSIONS = new Set([
  // immagini
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif", "tiff", "psd",
  // font
  "woff", "woff2", "ttf", "otf", "eot",
  // archivi
  "zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar", "jar", "war",
  // documenti e binari
  "pdf", "exe", "dll", "so", "dylib", "class", "wasm", "mp3", "mp4", "mov", "avi",
]);

export class SourceTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceTreeError";
  }
}

export interface SourceSkipped {
  binary: number;
  tooLarge: number;
  ignored: number;
}

interface ZipEntry {
  name: string;
  originalSize: number;
}

/** Normalizza un percorso interno allo zip; null se pericoloso (assoluto, unità, `..`). */
function normalizeEntryPath(raw: string): string | null {
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\0")) return null;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "..") return null;
    if (seg === "" || seg === ".") continue;
    parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

/** Normalizza un percorso richiesto dal chiamante (lettura/lista): tollera `./` e `/` iniziale. */
function normalizeQueryPath(raw: string): string | null {
  const parts: string[] = [];
  for (const seg of raw.replace(/\\/g, "/").split("/")) {
    if (seg === "..") return null;
    if (seg === "" || seg === ".") continue;
    parts.push(seg);
  }
  return parts.join("/");
}

function isBinaryByExtension(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 && BINARY_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

function hasNul(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Converte un glob (`*`, `**`, `?`) in una regex ancorata sul percorso. */
function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

function countLines(content: string): number {
  if (content === "") return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
}

export class SourceTree {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly skipped: SourceSkipped;
  private readonly files: Map<string, string>;
  private readonly sortedPaths: string[];

  private constructor(files: Map<string, string>, totalBytes: number, skipped: SourceSkipped) {
    this.files = files;
    this.fileCount = files.size;
    this.totalBytes = totalBytes;
    this.skipped = skipped;
    this.sortedPaths = [...files.keys()].sort();
  }

  static fromZip(bytes: Uint8Array, opts: { stripTopFolder?: boolean } = {}): SourceTree {
    if (bytes.length > SOURCE_LIMITS.maxZipBytes) {
      throw new SourceTreeError(
        `L'archivio supera il limite di ${Math.round(SOURCE_LIMITS.maxZipBytes / 1_048_576)} MB.`,
      );
    }

    // Passo 1: solo l'elenco delle voci (il filtro rifiuta tutto, nulla viene decompresso).
    const entries: ZipEntry[] = [];
    try {
      unzipSync(bytes, {
        filter: (f) => {
          entries.push({ name: f.name, originalSize: f.originalSize });
          return false;
        },
      });
    } catch {
      throw new SourceTreeError("L'archivio non è uno zip valido.");
    }

    let declared = 0;
    for (const e of entries) declared += e.originalSize;
    if (declared > MAX_DECLARED_TOTAL_BYTES) {
      throw new SourceTreeError(
        "L'archivio decompresso supera il limite di dimensione consentito.",
      );
    }

    // Percorsi normalizzati; voci pericolose e cartelle scartate, duplicati: vale la prima.
    const candidates = new Map<string, ZipEntry>();
    for (const e of entries) {
      if (e.name.endsWith("/")) continue;
      const path = normalizeEntryPath(e.name);
      if (path === null || candidates.has(path)) continue;
      candidates.set(path, e);
    }

    // Cartella radice unica (zipball GitHub).
    let prefix = "";
    if (opts.stripTopFolder && candidates.size > 0) {
      const tops = new Set<string>();
      let allNested = true;
      for (const path of candidates.keys()) {
        const slash = path.indexOf("/");
        if (slash < 0) allNested = false;
        else tops.add(path.slice(0, slash));
      }
      if (allNested && tops.size === 1) prefix = `${[...tops][0]}/`;
    }

    // Piano: quali file leggere (in base alla dimensione dichiarata) e quanto contano.
    const skipped: SourceSkipped = { binary: 0, tooLarge: 0, ignored: 0 };
    const plan = new Map<string, string>(); // nome nello zip -> percorso finale
    let plannedBytes = 0;
    for (const [fullPath, e] of candidates) {
      const path = prefix ? fullPath.slice(prefix.length) : fullPath;
      if (path.split("/").some((seg) => IGNORED_DIRS.has(seg))) {
        skipped.ignored++;
        continue;
      }
      if (isBinaryByExtension(path)) {
        skipped.binary++;
        continue;
      }
      if (e.originalSize > SOURCE_LIMITS.maxFileBytes) {
        skipped.tooLarge++;
        continue;
      }
      plannedBytes += e.originalSize;
      if (plan.size + 1 > SOURCE_LIMITS.maxFiles) {
        throw new SourceTreeError(
          `L'archivio contiene troppi file: limite di ${SOURCE_LIMITS.maxFiles}.`,
        );
      }
      if (plannedBytes > SOURCE_LIMITS.maxTotalBytes) {
        throw new SourceTreeError(
          `Il sorgente supera il limite di ${Math.round(SOURCE_LIMITS.maxTotalBytes / 1_048_576)} MB.`,
        );
      }
      plan.set(e.name, path);
    }

    // Passo 2: decomprime solo i file pianificati; ricontrolla la dimensione reale.
    const files = new Map<string, string>();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let totalBytes = 0;
    let raw: Record<string, Uint8Array>;
    try {
      raw = unzipSync(bytes, {
        filter: (f) =>
          plan.has(f.name) && f.originalSize <= SOURCE_LIMITS.maxFileBytes,
      });
    } catch {
      throw new SourceTreeError("L'archivio non è uno zip valido.");
    }
    for (const [name, data] of Object.entries(raw)) {
      const path = plan.get(name);
      if (path === undefined) continue;
      if (data.length > SOURCE_LIMITS.maxFileBytes) {
        skipped.tooLarge++;
        continue;
      }
      if (hasNul(data)) {
        skipped.binary++;
        continue;
      }
      totalBytes += data.length;
      if (totalBytes > SOURCE_LIMITS.maxTotalBytes) {
        throw new SourceTreeError(
          `Il sorgente supera il limite di ${Math.round(SOURCE_LIMITS.maxTotalBytes / 1_048_576)} MB.`,
        );
      }
      files.set(path, decoder.decode(data));
    }
    return new SourceTree(files, totalBytes, skipped);
  }

  has(path: string): boolean {
    const p = normalizeQueryPath(path);
    return p !== null && p !== "" && this.files.has(p);
  }

  list(dir: string, depth = 1): string[] {
    const d = normalizeQueryPath(dir);
    if (d === null) throw new SourceTreeError(`Percorso non valido: ${dir}`);
    const maxDepth = Math.min(Math.max(Math.trunc(depth) || 1, 1), MAX_LIST_DEPTH);
    const prefix = d === "" ? "" : `${d}/`;
    const out = new Set<string>();
    let found = d === "";
    for (const path of this.sortedPaths) {
      if (!path.startsWith(prefix)) continue;
      found = true;
      const parts = path.slice(prefix.length).split("/");
      for (let i = 0; i < Math.min(parts.length, maxDepth); i++) {
        const isFile = i === parts.length - 1;
        out.add(prefix + parts.slice(0, i + 1).join("/") + (isFile ? "" : "/"));
      }
    }
    if (!found) throw new SourceTreeError(`Cartella inesistente: ${dir}`);
    return [...out].sort();
  }

  read(
    path: string,
    fromLine = 1,
    toLine?: number,
  ): { content: string; totalLines: number; truncated: boolean } {
    const p = normalizeQueryPath(path);
    const text = p ? this.files.get(p) : undefined;
    if (text === undefined) throw new SourceTreeError(`File inesistente: ${path}`);
    const lines = text === "" ? [] : text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    const totalLines = lines.length;

    const start = Math.max(Math.trunc(fromLine) || 1, 1);
    let end = toLine === undefined ? totalLines : Math.min(Math.trunc(toLine), totalLines);
    end = Math.min(end, start + SOURCE_LIMITS.maxReadLines - 1);
    let slice = start <= end ? lines.slice(start - 1, end) : [];

    // Tetto sui caratteri: si taglia per righe intere (almeno una, eventualmente accorciata).
    let chars = 0;
    let keep = 0;
    for (const line of slice) {
      const next = chars + line.length + (keep > 0 ? 1 : 0);
      if (next > SOURCE_LIMITS.maxReadChars) break;
      chars = next;
      keep++;
    }
    if (keep === 0 && slice.length > 0) {
      slice = [slice[0]!.slice(0, SOURCE_LIMITS.maxReadChars)];
      keep = 1;
    }
    slice = slice.slice(0, keep);
    const lastReturned = start - 1 + slice.length;
    return {
      content: slice.join("\n"),
      totalLines,
      truncated: lastReturned < totalLines,
    };
  }

  search(
    pattern: string,
    opts: { glob?: string; regex?: boolean } = {},
  ): { path: string; line: number; text: string }[] {
    let test: (line: string) => boolean;
    if (opts.regex) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        throw new SourceTreeError(`Espressione regolare non valida: ${pattern}`);
      }
      test = (line) => re.test(line);
    } else {
      const needle = pattern.toLowerCase();
      test = (line) => line.toLowerCase().includes(needle);
    }
    const globRe = opts.glob ? globToRegex(opts.glob) : null;

    const results: { path: string; line: number; text: string }[] = [];
    for (const path of this.sortedPaths) {
      if (globRe && !globRe.test(path)) continue;
      const lines = this.files.get(path)!.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!test(line)) continue;
        results.push({
          path,
          line: i + 1,
          text: line.trim().slice(0, MAX_SEARCH_TEXT_CHARS),
        });
        if (results.length >= SOURCE_LIMITS.maxSearchResults) return results;
      }
    }
    return results;
  }
}

import { RegexSearchTimeout, RegexSearchWorker } from "./search-worker";
import { extractEntry, readZipEntries, ZipFormatError, type RawZipEntry } from "./zip-reader";

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

const MAX_RAW_ENTRIES = 50_000;
const MAX_REGEX_PATTERN_CHARS = 200;
const MAX_GLOB_CHARS = 200;
const MAX_REGEX_LINE_CHARS = 10_000;
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

type GlobToken =
  | { t: "lit"; c: string }
  | { t: "q" }
  | { t: "star" }
  | { t: "dstar" }
  | { t: "dstarslash" };

/**
 * Compila un glob (`*`, `**`, `?`) in un matcher a programmazione dinamica, O(glob × percorso)
 * nel caso peggiore: niente backtracking, quindi nessun ReDoS con glob o percorsi ostili.
 * `?` = un carattere tranne `/`; `*` = qualsiasi sequenza senza `/`; `**` = qualsiasi sequenza,
 * `/` compresi; `**\/` accetta anche zero cartelle.
 */
function compileGlob(glob: string): (path: string) => boolean {
  if (glob.length > MAX_GLOB_CHARS) {
    throw new SourceTreeError(`Glob troppo lungo (massimo ${MAX_GLOB_CHARS} caratteri).`);
  }
  const tokens: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      let run = 1;
      while (glob[i + run] === "*") run++;
      i += run - 1;
      if (run === 1) tokens.push({ t: "star" });
      else if (glob[i + 1] === "/") {
        tokens.push({ t: "dstarslash" });
        i += 1;
      } else tokens.push({ t: "dstar" });
    } else if (ch === "?") {
      tokens.push({ t: "q" });
    } else {
      tokens.push({ t: "lit", c: ch });
    }
  }
  return (path) => {
    const n = path.length;
    let prev = new Uint8Array(n + 1);
    let cur = new Uint8Array(n + 1);
    prev[0] = 1;
    for (const tok of tokens) {
      cur.fill(0);
      let seen = 0; // OR dei prev[0..j-1], per dstarslash
      for (let j = 0; j <= n; j++) {
        let v = 0;
        switch (tok.t) {
          case "lit":
            v = j > 0 && prev[j - 1] && path[j - 1] === tok.c ? 1 : 0;
            break;
          case "q":
            v = j > 0 && prev[j - 1] && path[j - 1] !== "/" ? 1 : 0;
            break;
          case "star":
            v = prev[j] || (j > 0 && cur[j - 1] && path[j - 1] !== "/") ? 1 : 0;
            break;
          case "dstar":
            v = prev[j] || (j > 0 && cur[j - 1]) ? 1 : 0;
            break;
          case "dstarslash":
            v = prev[j] || (j > 0 && path[j - 1] === "/" && seen) ? 1 : 0;
            break;
        }
        cur[j] = v;
        if (prev[j]) seen = 1;
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n] === 1;
  };
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
  private regexWorker: RegexSearchWorker | null = null;

  private constructor(files: Map<string, string>, totalBytes: number, skipped: SourceSkipped) {
    this.files = files;
    this.fileCount = files.size;
    this.totalBytes = totalBytes;
    this.skipped = skipped;
    this.sortedPaths = [...files.keys()].sort();
  }

  static fromZip(
    bytes: Uint8Array,
    opts: { stripTopFolder?: boolean; limits?: { maxRawEntries?: number } } = {},
  ): SourceTree {
    if (bytes.length > SOURCE_LIMITS.maxZipBytes) {
      throw new SourceTreeError(
        `L'archivio supera il limite di ${Math.round(SOURCE_LIMITS.maxZipBytes / 1_048_576)} MB.`,
      );
    }
    try {
      return SourceTree.build(bytes, opts);
    } catch (e) {
      if (e instanceof ZipFormatError) throw new SourceTreeError(e.message);
      throw e;
    }
  }

  private static build(
    bytes: Uint8Array,
    opts: { stripTopFolder?: boolean; limits?: { maxRawEntries?: number } },
  ): SourceTree {
    // Struttura validata per intero (sovrapposizioni, zip64, cifratura...) prima di leggere dati.
    const entries = readZipEntries(bytes, opts.limits?.maxRawEntries ?? MAX_RAW_ENTRIES);

    // Percorsi normalizzati; voci pericolose e cartelle scartate; duplicati: vale la prima.
    const candidates = new Map<string, RawZipEntry>();
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

    // Decisioni prima di decomprimere, sulla dimensione dichiarata (che l'estrazione poi impone).
    const skipped: SourceSkipped = { binary: 0, tooLarge: 0, ignored: 0 };
    const plan: [string, RawZipEntry][] = [];
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
      if (plan.length + 1 > SOURCE_LIMITS.maxFiles) {
        throw new SourceTreeError(
          `L'archivio contiene troppi file: limite di ${SOURCE_LIMITS.maxFiles}.`,
        );
      }
      plannedBytes += e.originalSize;
      if (plannedBytes > SOURCE_LIMITS.maxTotalBytes) {
        throw new SourceTreeError(
          `Il sorgente supera il limite di ${Math.round(SOURCE_LIMITS.maxTotalBytes / 1_048_576)} MB.`,
        );
      }
      plan.push([path, e]);
    }

    // Estrazione: output reale == dichiarato, altrimenti l'archivio è rifiutato (ZipFormatError).
    const files = new Map<string, string>();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let totalBytes = 0;
    for (const [path, e] of plan) {
      const data = extractEntry(bytes, e);
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

  async search(
    pattern: string,
    opts: { glob?: string; regex?: boolean } = {},
  ): Promise<{ path: string; line: number; text: string }[]> {
    const globMatch = opts.glob ? compileGlob(opts.glob) : null;

    if (opts.regex) {
      if (pattern.length > MAX_REGEX_PATTERN_CHARS) {
        throw new SourceTreeError(
          `Espressione regolare troppo lunga (massimo ${MAX_REGEX_PATTERN_CHARS} caratteri).`,
        );
      }
      try {
        new RegExp(pattern); // solo validazione: la costruzione è economica
      } catch {
        throw new SourceTreeError(`Espressione regolare non valida: ${pattern}`);
      }
      this.regexWorker ??= new RegexSearchWorker(() => [...this.files.entries()]);
      try {
        const paths = globMatch ? this.sortedPaths.filter(globMatch) : null;
        return await this.regexWorker.search(pattern, paths, {
          max: SOURCE_LIMITS.maxSearchResults,
          maxText: MAX_SEARCH_TEXT_CHARS,
          maxLine: MAX_REGEX_LINE_CHARS,
        });
      } catch (e) {
        if (e instanceof RegexSearchTimeout) {
          throw new SourceTreeError(
            "ricerca regex troppo lenta: usa una ricerca testuale",
          );
        }
        throw new SourceTreeError(
          "ricerca regex non disponibile: usa una ricerca testuale",
        );
      }
    }

    const needle = pattern.toLowerCase();
    const results: { path: string; line: number; text: string }[] = [];
    for (const path of this.sortedPaths) {
      if (globMatch && !globMatch(path)) continue;
      const lines = this.files.get(path)!.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.toLowerCase().includes(needle)) continue;
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

  /** Termina il worker della ricerca regex, se avviato. */
  async dispose(): Promise<void> {
    await this.regexWorker?.dispose();
    this.regexWorker = null;
  }
}

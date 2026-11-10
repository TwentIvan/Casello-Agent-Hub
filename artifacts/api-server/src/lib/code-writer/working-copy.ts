import type { SourceTree } from "../architect/source-tree";
import { CODE_WRITE_MESSAGES } from "./messages";

/** Copia di lavoro di un compito con codice: modifiche in memoria sopra un albero di sola lettura (spec §5). */

export const WORKING_COPY_LIMITS = {
  maxPaths: 100,
  maxFileBytes: 1_048_576,
  maxOldChars: 20_000,
  maxNewChars: 200_000,
} as const;

const MAX_PATH_CHARS = 300;

/** null = percorso valido, altrimenti il messaggio fisso. */
export function checkPath(path: string): string | null {
  if (path.length < 1 || path.length > MAX_PATH_CHARS) return CODE_WRITE_MESSAGES.badPath;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return CODE_WRITE_MESSAGES.badPath;
  const segs = path.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return CODE_WRITE_MESSAGES.badPath;
  if (segs[0] === ".git") return CODE_WRITE_MESSAGES.badPath;
  if (segs[0] === ".github" && segs[1] === "workflows") return CODE_WRITE_MESSAGES.workflows;
  const base = segs[segs.length - 1]!;
  if (base === ".env" || base.startsWith(".env.")) return CODE_WRITE_MESSAGES.badPath;
  return null;
}

export class WorkingCopy {
  private readonly base: SourceTree;
  private committed = new Map<string, string | null>();
  private pendingChanges = new Map<string, string | null>();
  private cached: SourceTree | null = null;
  /** Vista superata da una modifica: si chiude (worker della ricerca regex) quando se ne costruisce una nuova. */
  private stale: SourceTree | null = null;

  constructor(base: SourceTree) {
    this.base = base;
  }

  view(): SourceTree {
    if (this.cached === null) {
      this.cached = this.base.withChanges(new Map([...this.committed, ...this.pendingChanges]));
      this.disposeStale();
    }
    return this.cached;
  }

  private invalidate(): void {
    if (this.cached !== null) {
      // Una vista superata due volte prima di una nuova lettura: la più vecchia si chiude subito
      this.disposeStale();
      this.stale = this.cached;
    }
    this.cached = null;
  }

  private disposeStale(): void {
    if (this.stale !== null && this.stale !== this.base) void this.stale.dispose();
    this.stale = null;
  }

  /** Chiude l'albero di partenza e le viste (worker della ricerca regex): la copia di lavoro non si usa più. */
  async dispose(): Promise<void> {
    const trees = [this.base, this.cached, this.stale].filter((t): t is SourceTree => t !== null);
    this.cached = null;
    this.stale = null;
    await Promise.all(trees.map((t) => t.dispose()));
  }

  private totalPaths(extra: string): number {
    const all = new Set([...this.committed.keys(), ...this.pendingChanges.keys()]);
    all.add(extra);
    return all.size;
  }

  write(path: string, content: string): string | null {
    const bad = checkPath(path);
    if (bad) return bad;
    if (content.includes("\0")) return CODE_WRITE_MESSAGES.binary(path);
    if (Buffer.byteLength(content, "utf8") > WORKING_COPY_LIMITS.maxFileBytes) {
      return CODE_WRITE_MESSAGES.tooLarge(path);
    }
    if (this.totalPaths(path) > WORKING_COPY_LIMITS.maxPaths) return CODE_WRITE_MESSAGES.tooMany;
    this.pendingChanges.set(path, content);
    this.invalidate();
    return null;
  }

  edit(path: string, oldText: string, newText: string): string | null {
    const bad = checkPath(path);
    if (bad) return bad;
    if (oldText.length < 1 || oldText.length > WORKING_COPY_LIMITS.maxOldChars) {
      return CODE_WRITE_MESSAGES.textNotFound;
    }
    if (newText.length > WORKING_COPY_LIMITS.maxNewChars) return CODE_WRITE_MESSAGES.tooLarge(path);
    const text = this.view().text(path);
    if (text === undefined) return CODE_WRITE_MESSAGES.notFound(path);
    const parts = text.split(oldText);
    const n = parts.length - 1;
    if (n === 0) return CODE_WRITE_MESSAGES.textNotFound;
    if (n > 1) return CODE_WRITE_MESSAGES.textRepeated(n);
    return this.write(path, parts[0]! + newText + parts[1]!);
  }

  remove(path: string): string | null {
    const bad = checkPath(path);
    if (bad) return bad;
    if (!this.view().has(path)) return CODE_WRITE_MESSAGES.notFound(path);
    // Un file nato solo nella copia in sospeso (né nell'albero né già committato): basta dimenticarlo
    if (!this.base.has(path) && !this.committed.has(path)) {
      this.pendingChanges.delete(path);
      this.invalidate();
      return null;
    }
    if (this.totalPaths(path) > WORKING_COPY_LIMITS.maxPaths) return CODE_WRITE_MESSAGES.tooMany;
    this.pendingChanges.set(path, null);
    this.invalidate();
    return null;
  }

  pending(): Map<string, string | null> {
    return new Map(this.pendingChanges);
  }

  pendingCount(): number {
    return this.pendingChanges.size;
  }

  markCommitted(): void {
    for (const [p, c] of this.pendingChanges) this.committed.set(p, c);
    this.pendingChanges = new Map();
  }
}

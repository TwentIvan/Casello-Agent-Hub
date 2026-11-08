import { parseFieldPath } from "./config";

// Funzioni pure: estrazione degli elementi dalla risposta di un tool o dal corpo di un webhook.

export const MAX_ITEMS_READ = 500;
const MAX_ID_LENGTH = 200;
const MAX_VERSION_LENGTH = 99;

export type ExtractConfig = {
  itemsPath: string | null;
  idField: string;
  versionField: string | null;
  cursorField: string | null;
  filter: { field: string; equals: string | number | boolean } | null;
};

export type ExtractedItem = {
  key: string;
  cursor: string | number | null;
  value: Record<string, unknown>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

// Legge un percorso (segmenti già separati): solo proprietà proprie di oggetti semplici, mai array.
export function readPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined;
    if (!isPlainObject(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

// Legge un campo dato come stringa con punti; un percorso non valido equivale a «non trovato».
function readField(item: unknown, dotted: string): unknown {
  const path = parseFieldPath(dotted);
  return path ? readPath(item, path) : undefined;
}

function scalarToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function itemKey(item: Record<string, unknown>, cfg: ExtractConfig): string | null {
  const id = scalarToString(readField(item, cfg.idField));
  if (id === null || id.length === 0 || id.length > MAX_ID_LENGTH) return null;
  if (!cfg.versionField) return id;
  const version = scalarToString(readField(item, cfg.versionField));
  if (version === null || version.length === 0) return id;
  if (version.length > MAX_VERSION_LENGTH) return null;
  return `${id}\u001f${version}`;
}

// Uguaglianza stretta su stringa, numero o booleano; senza filtro tutto passa.
export function matchesFilter(item: Record<string, unknown>, filter: ExtractConfig["filter"]): boolean {
  if (!filter) return true;
  return readField(item, filter.field) === filter.equals;
}

export function compareCursor(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function readCursor(item: Record<string, unknown>, cfg: ExtractConfig): string | number | null {
  if (!cfg.cursorField) return null;
  const value = readField(item, cfg.cursorField);
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function extractItems(
  response: unknown,
  cfg: ExtractConfig,
): { ok: true; items: ExtractedItem[]; skipped: number } | { ok: false; error: "listNotFound" } {
  let list: unknown = response;
  if (cfg.itemsPath !== null) {
    const path = parseFieldPath(cfg.itemsPath);
    list = path ? readPath(response, path) : undefined;
  }
  if (!Array.isArray(list)) return { ok: false, error: "listNotFound" };

  const items: ExtractedItem[] = [];
  let skipped = 0;
  for (const element of list.slice(0, MAX_ITEMS_READ)) {
    if (!isPlainObject(element)) {
      skipped += 1;
      continue;
    }
    const key = itemKey(element, cfg);
    if (key === null) {
      skipped += 1;
      continue;
    }
    if (!matchesFilter(element, cfg.filter)) continue;
    items.push({ key, cursor: readCursor(element, cfg), value: element });
  }
  return { ok: true, items, skipped };
}

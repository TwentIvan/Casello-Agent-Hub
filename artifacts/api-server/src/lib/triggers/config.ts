import { TRIGGER_MESSAGES } from "./messages";

// Validazione di forma della configurazione di un innesco. Le regole sul tool e sui limiti di quantità
// stanno nel servizio.

const SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ARGS_BYTES = 8 * 1024;
const MAX_INSTRUCTIONS = 2000;
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 86_400;
export const DEFAULT_INTERVAL_SECONDS = 300;

// Percorso con punti: da 1 a 5 segmenti validi, altrimenti null.
export function parseFieldPath(path: string): string[] | null {
  if (typeof path !== "string") return null;
  const segments = path.split(".");
  if (segments.length < 1 || segments.length > 5) return null;
  return segments.every((s) => SEGMENT_RE.test(s)) ? segments : null;
}

export type TriggerFilter = { field: string; equals: string | number | boolean };

export type TriggerConfigInput = {
  kind: "poll" | "webhook";
  name: string;
  instructions?: string | null;
  toolId?: number | null;
  args?: Record<string, unknown> | null;
  itemsPath?: string | null;
  idField?: string | null;
  versionField?: string | null;
  cursorParam?: string | null;
  cursorField?: string | null;
  filter?: TriggerFilter | null;
  intervalSeconds?: number | null;
  dedupHeader?: string | null;
};

export type NormalizedTriggerConfig = {
  kind: "poll" | "webhook";
  name: string;
  instructions: string | null;
  toolId: number | null;
  args: Record<string, unknown>;
  itemsPath: string | null;
  idField: string | null;
  versionField: string | null;
  cursorParam: string | null;
  cursorField: string | null;
  filter: TriggerFilter | null;
  intervalSeconds: number | null;
  dedupHeader: string | null;
};

type Result = { ok: true; value: NormalizedTriggerConfig } | { ok: false; error: string };

const fail = (error: string): Result => ({ ok: false, error });
const present = (v: unknown) => v !== undefined && v !== null;
const HEADER_RE = /^[A-Za-z0-9-]{1,100}$/;

export function validateTriggerConfig(input: TriggerConfigInput): Result {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return fail(TRIGGER_MESSAGES.invalidName);

  const instructions = present(input.instructions) ? String(input.instructions).trim() : null;
  if (instructions !== null && instructions.length > MAX_INSTRUCTIONS) {
    return fail(TRIGGER_MESSAGES.instructionsTooLong);
  }

  const isPoll = input.kind === "poll";
  // Campi propri di un solo tipo: presenti sull'altro sono un errore.
  if (isPoll) {
    if (present(input.dedupHeader)) return fail(TRIGGER_MESSAGES.wrongKindFields);
  } else if (
    present(input.toolId) ||
    present(input.args) ||
    present(input.cursorParam) ||
    present(input.cursorField) ||
    present(input.intervalSeconds)
  ) {
    return fail(TRIGGER_MESSAGES.wrongKindFields);
  }

  // Percorsi.
  const paths: Array<string | null | undefined> = [input.itemsPath, input.versionField, input.cursorField];
  if (isPoll || present(input.idField)) paths.push(input.idField ?? "id");
  for (const p of paths) {
    if (present(p) && parseFieldPath(p as string) === null) return fail(TRIGGER_MESSAGES.invalidPath);
  }

  let filter: TriggerFilter | null = null;
  if (present(input.filter)) {
    const f = input.filter as TriggerFilter;
    if (!f || typeof f !== "object" || typeof f.field !== "string") return fail(TRIGGER_MESSAGES.invalidFilter);
    if (parseFieldPath(f.field) === null) return fail(TRIGGER_MESSAGES.invalidPath);
    const t = typeof f.equals;
    if (t !== "string" && t !== "boolean" && !(t === "number" && Number.isFinite(f.equals))) {
      return fail(TRIGGER_MESSAGES.invalidFilter);
    }
    filter = { field: f.field, equals: f.equals };
  }

  let dedupHeader: string | null = null;
  if (present(input.dedupHeader)) {
    if (!HEADER_RE.test(input.dedupHeader as string)) return fail(TRIGGER_MESSAGES.invalidArgs);
    dedupHeader = input.dedupHeader as string;
  }

  let args: Record<string, unknown> = {};
  let intervalSeconds: number | null = null;
  let toolId: number | null = null;
  let cursorParam: string | null = null;
  if (isPoll) {
    if (!Number.isInteger(input.toolId)) return fail(TRIGGER_MESSAGES.toolNotUsable);
    toolId = input.toolId as number;

    if (present(input.args)) {
      const a = input.args;
      if (typeof a !== "object" || a === null || Array.isArray(a)) return fail(TRIGGER_MESSAGES.invalidArgs);
      if (Buffer.byteLength(JSON.stringify(a), "utf8") > MAX_ARGS_BYTES) return fail(TRIGGER_MESSAGES.argsTooLarge);
      args = a;
    }

    const interval = input.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS) {
      return fail(TRIGGER_MESSAGES.invalidInterval);
    }
    intervalSeconds = interval;

    if (present(input.cursorParam)) {
      if (typeof input.cursorParam !== "string" || !SEGMENT_RE.test(input.cursorParam)) {
        return fail(TRIGGER_MESSAGES.invalidArgs);
      }
      if (!present(input.cursorField)) return fail(TRIGGER_MESSAGES.cursorFieldRequired);
      cursorParam = input.cursorParam;
    }
  }

  return {
    ok: true,
    value: {
      kind: input.kind,
      name,
      instructions: instructions && instructions.length > 0 ? instructions : null,
      toolId,
      args,
      itemsPath: input.itemsPath ?? null,
      idField: isPoll ? (input.idField ?? "id") : (input.idField ?? null),
      versionField: input.versionField ?? null,
      cursorParam,
      cursorField: isPoll ? (input.cursorField ?? null) : null,
      filter,
      intervalSeconds,
      dedupHeader,
    },
  };
}

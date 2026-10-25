import type { CatalogTool } from "./types";

// Oscuramento degli argomenti sensibili (proprietà con `"x-sensitive": true` nello schema dei
// parametri). Modulo puro: niente DB, usabile dal ciclo dell'agente e dall'orchestratore.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitive(schema: unknown): boolean {
  return isPlainObject(schema) && schema["x-sensitive"] === true;
}

function hasSensitive(schema: unknown): boolean {
  if (isSensitive(schema)) return true;
  if (!isPlainObject(schema)) return false;
  const props = schema["properties"];
  return isPlainObject(props) && Object.values(props).some(hasSensitive);
}

function maskWith(schema: unknown, value: unknown): unknown {
  if (isSensitive(schema)) return "***";
  if (!isPlainObject(schema)) return value;
  const props = schema["properties"];
  if (!isPlainObject(props)) return value;
  if (!isPlainObject(value)) return hasSensitive(schema) ? "***" : value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = Object.hasOwn(props, key) ? maskWith(props[key], v) : v;
  }
  return out;
}

/**
 * Argomenti pronti per `run_steps`: le proprietà con `"x-sensitive": true` diventano "***"
 * (anche annidate). Argomenti che non sono un oggetto (es. JSON non valido) vengono oscurati
 * per intero se lo schema ha proprietà sensibili. Non modifica il valore ricevuto.
 */
export function maskSensitiveArgs(tool: CatalogTool, args: unknown): unknown {
  return maskWith(tool.paramsSchema, args);
}

/** Come maskSensitiveArgs, a partire dal solo schema dei parametri (es. riga di un tool non più attivo). */
export function maskArgsWithSchema(paramsSchema: unknown, args: unknown): unknown {
  return maskWith(paramsSchema, args);
}

const RAW_ARGS_CHARS = 500;

/**
 * Argomenti pronti per `run_steps.args`, sempre un oggetto (il contratto vuole object|null):
 * un oggetto viene oscurato come in maskSensitiveArgs; qualunque altro valore (JSON non valido,
 * array, stringa…) diventa `{ "_raw": "<testo troncato a 500 caratteri>" }`, oppure
 * `{ "_raw": "***" }` se lo schema ha proprietà sensibili.
 */
export function stepArgsWithSchema(paramsSchema: unknown, args: unknown): Record<string, unknown> {
  if (isPlainObject(args)) return maskWith(paramsSchema, args) as Record<string, unknown>;
  if (hasSensitive(paramsSchema)) return { _raw: "***" };
  const text = typeof args === "string" ? args : (JSON.stringify(args) ?? String(args));
  return { _raw: text.slice(0, RAW_ARGS_CHARS) };
}

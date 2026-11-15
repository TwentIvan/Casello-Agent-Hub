// Tool composti (`kind: composite`): eseguono in sequenza più tool `http`/`mcp` della stessa app e
// restituiscono un output combinato. Modulo puro: la lettura dei tool dei passi dal DB sta in catalog.ts,
// la chiamata di ogni passo la fa l'esecutore (`executeTool`), che passa sé stesso come `executeStep`.
//
// Regole (le stesse dei tool semplici):
// - livello: quello effettivo del composto è il più alto tra il suo e quelli dei passi, così un passo L2
//   manda in coda tutto il composto e un passo L3 lo rende inutilizzabile (`buildComposite`);
// - oscuramento: un argomento del composto che finisce in un parametro `x-sensitive` di un passo diventa
//   sensibile anche nello schema del composto (timeline, coda, risultati);
// - ogni passo passa dall'esecutore di sempre (validazione degli argomenti, autenticazione, limiti, oscuramento
//   delle credenziali); il composto ha in più un tempo massimo complessivo.

import { parseCompositeTemplate, parseDefinition, type CompositeTemplate } from "./definition";
import { effectiveLevel, TOOL_LEVELS, type ToolLevel } from "./levels";
import type { CatalogTool, CompositeDefinition, ToolResult } from "./types";

/** Tempo massimo di tutti i passi di un tool composto (ogni passo ha anche il suo timeout). */
export const COMPOSITE_TIMEOUT_MS = 60_000;

/** Tipi di tool ammessi come passo: niente composti dentro composti, niente tool `ui`. */
export const COMPOSITE_STEP_KINDS = ["http", "mcp"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maxLevel(a: ToolLevel, b: ToolLevel): ToolLevel {
  return TOOL_LEVELS.indexOf(a) >= TOOL_LEVELS.indexOf(b) ? a : b;
}

function stepParamSchema(step: CatalogTool, param: string): unknown {
  const props = step.paramsSchema["properties"];
  return isPlainObject(props) && Object.hasOwn(props, param) ? props[param] : undefined;
}

function declaredParams(schema: Record<string, unknown>): Set<string> {
  const props = schema["properties"];
  return new Set(isPlainObject(props) ? Object.keys(props) : []);
}

/**
 * Collega un tool composto ai tool dei suoi passi (`byName`: tool della stessa app, già convertiti con
 * `toCatalogTool`). Verifica che ogni passo esista, sia `active`, `http`/`mcp`, della stessa app, con livello
 * effettivo diverso da L3 e che i parametri usati siano dichiarati; poi alza il livello del composto al più
 * alto dei passi e marca come sensibili gli argomenti che finiscono in parametri sensibili.
 */
export function buildComposite(
  tool: CatalogTool,
  byName: Map<string, CatalogTool>,
): { ok: true; tool: CatalogTool } | { ok: false; error: string } {
  const parsed = parseDefinition("composite", tool.definition);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const def = parsed.value as CompositeDefinition;

  const steps: CatalogTool[] = [];
  let level = effectiveLevel(tool);
  const sensitiveInputs = new Set<string>();
  for (const [i, step] of def.steps.entries()) {
    const target = byName.get(step.tool);
    if (!target || target.appId !== tool.appId) return { ok: false, error: `passo ${i}: il tool "${step.tool}" non esiste nell'app` };
    if (target.status !== "active") return { ok: false, error: `passo ${i}: il tool "${step.tool}" non è attivo` };
    if (!(COMPOSITE_STEP_KINDS as readonly string[]).includes(target.kind)) {
      return { ok: false, error: `passo ${i}: il tool "${step.tool}" non è un tool http o mcp` };
    }
    const stepLevel = effectiveLevel(target);
    if (stepLevel === "L3") return { ok: false, error: `passo ${i}: il tool "${step.tool}" è vietato (L3)` };
    level = maxLevel(level, stepLevel);
    const declared = declaredParams(target.paramsSchema);
    for (const [param, value] of Object.entries(step.args)) {
      if (!declared.has(param)) return { ok: false, error: `passo ${i}: il parametro "${param}" non è di "${step.tool}"` };
      const t = parseCompositeTemplate(value);
      const schema = stepParamSchema(target, param);
      if (t?.kind === "input" && isPlainObject(schema) && schema["x-sensitive"] === true) {
        // Con `$input` intero si oscurano tutti gli argomenti: lo segnala la chiave vuota
        sensitiveInputs.add(t.path[0] ?? "");
      }
    }
    steps.push(target);
  }

  let paramsSchema = tool.paramsSchema;
  if (sensitiveInputs.size > 0) {
    const props = isPlainObject(paramsSchema["properties"]) ? paramsSchema["properties"] : {};
    const all = sensitiveInputs.has("");
    const marked: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(props)) {
      marked[name] = all || sensitiveInputs.has(name) ? { ...(isPlainObject(schema) ? schema : {}), "x-sensitive": true } : schema;
    }
    paramsSchema = { ...paramsSchema, properties: marked };
  }

  const levelOverride = level !== effectiveLevel(tool) ? level : tool.levelOverride;
  return { ok: true, tool: { ...tool, definition: def, paramsSchema, levelOverride, compositeSteps: steps } };
}

/** Valore in fondo a un percorso di proprietà proprie; undefined se manca. */
function walk(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function resolveTemplate(t: CompositeTemplate, input: Record<string, unknown>, results: unknown[]): unknown {
  if (t.kind === "literal") return t.value;
  if (t.kind === "input") return walk(input, t.path);
  return walk(results[t.step], t.path);
}

/** Valori di `args` o `output`; un riferimento senza valore si omette (parametro facoltativo o campo assente). */
function resolveRecord(templates: Record<string, string>, input: Record<string, unknown>, results: unknown[]): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(templates)) {
    const t = parseCompositeTemplate(value);
    if (!t) continue; // la definizione è già validata: non succede
    const resolved = resolveTemplate(t, input, results);
    if (resolved !== undefined) out[name] = resolved;
  }
  return out;
}

function parseResult(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

/**
 * Esegue i passi di un tool composto già collegato (`buildComposite`) e restituisce l'output combinato:
 * con `output` vuoto il risultato dell'ultimo passo, altrimenti un oggetto con i campi indicati. Al primo passo
 * fallito si ferma e lo dice («passo N (nome): …»); i passi già eseguiti non si annullano.
 */
export async function runComposite(input: {
  tool: CatalogTool;
  args: Record<string, unknown>;
  /** Esegue un passo con l'esecutore di sempre e restituisce la risposta intera (raw) */
  executeStep(step: CatalogTool, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ToolResult> {
  const { tool, args } = input;
  const def = tool.definition as CompositeDefinition;
  const steps = tool.compositeSteps;
  if (!steps || steps.length !== def.steps.length) return { ok: false, content: "passi del tool composto non disponibili" };

  const deadline = AbortSignal.timeout(input.timeoutMs ?? COMPOSITE_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const results: unknown[] = [];
  let status: number | undefined;
  for (const [i, step] of def.steps.entries()) {
    const target = steps[i]!;
    if (!(COMPOSITE_STEP_KINDS as readonly string[]).includes(target.kind) || effectiveLevel(target) === "L3") {
      return { ok: false, content: `passo ${i} (${target.name}): tool non utilizzabile in un tool composto` };
    }
    if (signal.aborted) {
      return {
        ok: false,
        content: deadline.aborted
          ? `tempo massimo del tool composto superato (${Math.round((input.timeoutMs ?? COMPOSITE_TIMEOUT_MS) / 1000)} s) prima del passo ${i}`
          : `tool composto interrotto prima del passo ${i}`,
      };
    }
    const result = await input.executeStep(target, resolveRecord(step.args, args, results), signal);
    if (!result.ok) {
      const failed: ToolResult = { ok: false, content: `passo ${i} (${target.name}): ${result.content}` };
      return result.status === undefined ? failed : { ...failed, status: result.status };
    }
    status = result.status;
    results.push(parseResult(result.content));
  }

  const output = Object.keys(def.output).length === 0 ? results[results.length - 1] : resolveRecord(def.output, args, results);
  const content = typeof output === "string" ? output : (JSON.stringify(output) ?? "(risposta vuota)");
  return status === undefined ? { ok: true, content } : { ok: true, status, content };
}

// Ciclo di una fase dell'architetto: il modello esplora il codice e l'OpenAPI con strumenti di
// sola lettura e consegna l'esito con `submit_result`, validato con lo schema Zod della fase.
// Modulo senza DB né rete: il modello arriva da `chat`, le sorgenti sono già in memoria.
// Il contenuto del repository è dato non attendibile: torna al modello come testo e non finisce
// mai nei log (solo righe brevi con nome dello strumento, percorso e conteggi).

import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ZodIssue } from "zod";
import type { ChatResult } from "../ai-gateway";
import { PHASE_SCHEMAS, type PhaseName } from "./schemas";
import { SOURCE_LIMITS, SourceTreeError, type SourceTree } from "./source-tree";
import { describeOperation, type OpenApiDoc } from "./sources";
import { sliceChars } from "./text";

export const PHASE_MAX_ROUNDS = 40;
export const MAX_CORRECTIONS = 2;

// Tetti sul testo restituito al modello per ogni chiamata
const MAX_TOOL_OUTPUT_CHARS = 40_000;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 200;
const MAX_OPERATIONS = 500;
const MAX_SUMMARY_CHARS = 150;
const MAX_ARG_CHARS = 1_000;
const MAX_ISSUES = 30;
const MAX_ISSUE_CHARS = 300;
const MAX_ERROR_CHARS = 1_000;
const MAX_LOG_ARG_CHARS = 120;

/**
 * Caratteri di output degli strumenti di lettura che restano interi nella cronologia: si tengono
 * i più recenti, i più vecchi diventano un segnaposto breve (vedi `compactHistory`).
 */
export const HISTORY_TOOL_OUTPUT_BUDGET = 60_000;

/** Budget dell'analisi, condiviso tra le fasi e aggiornato dal ciclo. */
export interface PhaseBudget {
  tokensUsed: number;
  maxTokens: number;
  /** Istante (ms, stesso orologio di `now`) oltre il quale non parte più nessuna chiamata al modello */
  deadline: number;
}

export interface RunPhaseInput {
  phase: PhaseName;
  system: string;
  user: string;
  tree: SourceTree | null;
  openapi: OpenApiDoc | null;
  chat: (messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]) => Promise<ChatResult>;
  budget: PhaseBudget;
  log: (message: string) => void;
  now?: () => number;
}

export type PhaseOutcome = { ok: true; result: unknown } | { ok: false; error: string };

type ReadToolName = "list_dir" | "read_file" | "search" | "list_operations" | "read_operation";

function fn(name: string, description: string, parameters: Record<string, unknown>): ChatCompletionFunctionTool {
  return { type: "function", function: { name, description, parameters } };
}

/** Definizioni degli strumenti di sola lettura (offerti solo se la sorgente è disponibile). */
export const READ_TOOLS: Record<ReadToolName, ChatCompletionFunctionTool> = {
  list_dir: fn("list_dir", "Elenca file e cartelle (le cartelle finiscono con '/') sotto un percorso del repository.", {
    type: "object",
    properties: {
      path: { type: "string", description: "Cartella da elencare, relativa alla radice ('' per la radice)" },
      depth: { type: "integer", description: "Profondità da 1 a 5 (default 1)" },
    },
    required: ["path"],
  }),
  read_file: fn(
    "read_file",
    `Legge un file di testo del repository con le righe numerate (massimo ${SOURCE_LIMITS.maxReadLines} righe per chiamata).`,
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Percorso del file, relativo alla radice" },
        fromLine: { type: "integer", description: "Prima riga da leggere (da 1)" },
        toLine: { type: "integer", description: "Ultima riga da leggere (compresa)" },
      },
      required: ["path"],
    },
  ),
  search: fn(
    "search",
    `Cerca un testo (o un'espressione regolare) nei file del repository; restituisce percorso:riga: testo (massimo ${SOURCE_LIMITS.maxSearchResults} risultati).`,
    {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Testo da cercare (senza distinzione tra maiuscole e minuscole) o espressione regolare" },
        glob: { type: "string", description: "Filtro sui percorsi, es. 'src/**/*.ts'" },
        regex: { type: "boolean", description: "true per interpretare pattern come espressione regolare" },
      },
      required: ["pattern"],
    },
  ),
  list_operations: fn("list_operations", "Elenca le operazioni del contratto OpenAPI: METODO percorso — operationId — summary.", {
    type: "object",
    properties: {},
  }),
  read_operation: fn(
    "read_operation",
    "Descrive un'operazione del contratto OpenAPI: parametri, corpo della richiesta e risposte.",
    {
      type: "object",
      properties: {
        method: { type: "string", description: "Metodo HTTP, es. GET" },
        path: { type: "string", description: "Percorso esattamente come nel contratto, es. /api/squadre/{id}" },
      },
      required: ["method", "path"],
    },
  ),
};

/** Strumento di consegna: lo schema vero è quello Zod della fase, applicato alla ricezione. */
export const SUBMIT_TOOL: ChatCompletionFunctionTool = fn(
  "submit_result",
  "Consegna l'esito della fase. `result` deve rispettare lo schema richiesto dalla fase; se viene rifiutato, correggi gli errori indicati e consegna di nuovo l'esito completo.",
  { type: "object", properties: { result: { type: "object" } }, required: ["result"] },
);

/** Strumenti offerti al modello in base alle sorgenti disponibili. */
export function phaseTools(hasCode: boolean, hasOpenApi: boolean): ChatCompletionFunctionTool[] {
  return [
    ...(hasCode ? [READ_TOOLS.list_dir, READ_TOOLS.read_file, READ_TOOLS.search] : []),
    ...(hasOpenApi ? [READ_TOOLS.list_operations, READ_TOOLS.read_operation] : []),
    SUBMIT_TOOL,
  ];
}

// --- Argomenti ------------------------------------------------------------------------------

type ArgType = "string" | "integer" | "boolean";
type ArgSpec = Record<string, { type: ArgType; required?: boolean }>;

const ARG_TYPE_IT: Record<ArgType, string> = {
  string: "una stringa",
  integer: "un numero intero",
  boolean: "un booleano",
};

type Parsed = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

function parseArgs(name: string, raw: string): Parsed {
  // Alcuni modelli inviano una stringa vuota quando non ci sono argomenti
  let value: unknown;
  try {
    value = JSON.parse(raw.trim() === "" ? "{}" : raw);
  } catch {
    return { ok: false, error: `gli argomenti di "${name}" non sono JSON valido` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `gli argomenti di "${name}" devono essere un oggetto JSON` };
  }
  return { ok: true, args: value as Record<string, unknown> };
}

function checkArgs(name: string, args: Record<string, unknown>, spec: ArgSpec): string | null {
  const problems: string[] = [];
  for (const [key, { type, required }] of Object.entries(spec)) {
    const v = args[key];
    if (v === undefined || v === null) {
      if (required) problems.push(`${key}: campo obbligatorio (${ARG_TYPE_IT[type]})`);
      continue;
    }
    const okType =
      type === "string" ? typeof v === "string" : type === "integer" ? Number.isInteger(v) : typeof v === "boolean";
    if (!okType) problems.push(`${key}: deve essere ${ARG_TYPE_IT[type]}`);
    else if (type === "string" && (v as string).length > MAX_ARG_CHARS) {
      problems.push(`${key}: testo troppo lungo (massimo ${MAX_ARG_CHARS} caratteri)`);
    }
  }
  return problems.length ? `argomenti di "${name}" non validi: ${problems.join("; ")}` : null;
}

// --- Formattazione --------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Valore breve e su una riga per i log (percorsi e pattern scelti dal modello). */
function logArg(value: string): string {
  const flat = value.replace(/[\r\n\t]+/g, " ");
  return flat.length > MAX_LOG_ARG_CHARS ? `${sliceChars(flat, MAX_LOG_ARG_CHARS)}…` : flat;
}

function capOutput(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${sliceChars(text, MAX_TOOL_OUTPUT_CHARS)}\n[...troncato: output oltre ${MAX_TOOL_OUTPUT_CHARS} caratteri]`
    : text;
}

function formatIssues(issues: ZodIssue[]): string[] {
  const lines = issues.slice(0, MAX_ISSUES).map((i) => {
    const where = i.path.length ? i.path.join(".") : "(esito)";
    return sliceChars(`${where}: ${i.message}`, MAX_ISSUE_CHARS);
  });
  if (issues.length > MAX_ISSUES) lines.push(`... e altri ${issues.length - MAX_ISSUES} problemi`);
  return lines;
}

// --- Esecuzione degli strumenti di lettura ----------------------------------------------------

interface ToolOutput {
  content: string;
  log: string;
}

const READ_SPECS: Record<ReadToolName, ArgSpec> = {
  list_dir: { path: { type: "string", required: true }, depth: { type: "integer" } },
  read_file: { path: { type: "string", required: true }, fromLine: { type: "integer" }, toLine: { type: "integer" } },
  search: { pattern: { type: "string", required: true }, glob: { type: "string" }, regex: { type: "boolean" } },
  list_operations: {},
  read_operation: { method: { type: "string", required: true }, path: { type: "string", required: true } },
};

function listDir(tree: SourceTree, path: string, depth: number | undefined): ToolOutput {
  const entries = tree.list(path, depth ?? 1);
  const shown = entries.slice(0, MAX_LIST_ENTRIES);
  const lines = shown.length ? shown : ["(cartella vuota)"];
  if (entries.length > shown.length) {
    lines.push(`[...altre ${entries.length - shown.length} voci non mostrate: elenca una sottocartella o riduci depth]`);
  }
  return {
    content: lines.join("\n"),
    log: `list_dir ${logArg(path || "/")} (${plural(entries.length, "voce", "voci")})`,
  };
}

function readFile(tree: SourceTree, path: string, fromLine: number | undefined, toLine: number | undefined): ToolOutput {
  const { content, totalLines } = tree.read(path, fromLine ?? 1, toLine);
  const start = Math.max(Math.trunc(fromLine ?? 1) || 1, 1);
  const empty = start > totalLines || (toLine !== undefined && Math.trunc(toLine) < start);
  const lines = empty ? [] : content.split("\n");
  const log = `read_file ${logArg(path)} (${plural(lines.length, "riga", "righe")})`;
  if (lines.length === 0) {
    return { content: `Nessuna riga da mostrare: il file ${path} ha ${totalLines} righe.`, log };
  }
  const last = start + lines.length - 1;
  const requestedEnd = Math.min(toLine === undefined ? totalLines : Math.trunc(toLine), totalLines);
  const out = [`File ${path}, righe ${start}-${last} di ${totalLines}:`];
  lines.forEach((text, i) => out.push(`${start + i}: ${text}`));
  if (last < requestedEnd) {
    out.push(`[...troncato al limite di lettura: continua con fromLine=${last + 1}]`);
  }
  return { content: capOutput(out.join("\n")), log };
}

async function search(
  tree: SourceTree,
  pattern: string,
  glob: string | undefined,
  regex: boolean | undefined,
): Promise<ToolOutput> {
  const results = await tree.search(pattern, { glob, regex });
  const shown = results.slice(0, MAX_SEARCH_MATCHES);
  const lines = shown.map((r) => `${r.path}:${r.line}: ${r.text}`);
  if (lines.length === 0) lines.push("Nessun risultato.");
  if (results.length >= Math.min(SOURCE_LIMITS.maxSearchResults, MAX_SEARCH_MATCHES)) {
    lines.push(`[risultati limitati a ${shown.length}: restringi la ricerca con glob o un pattern più specifico]`);
  }
  return {
    content: capOutput(lines.join("\n")),
    log: `search "${logArg(pattern)}"${regex ? " (regex)" : ""} (${plural(results.length, "risultato", "risultati")})`,
  };
}

function listOperations(doc: OpenApiDoc): ToolOutput {
  const ops = doc.operations.slice(0, MAX_OPERATIONS);
  const lines = ops.map((op) =>
    [
      `${op.method.toUpperCase()} ${op.path}`,
      op.operationId,
      op.summary ? sliceChars(op.summary.replace(/\s+/g, " "), MAX_SUMMARY_CHARS) : null,
    ]
      .filter(Boolean)
      .join(" — "),
  );
  if (lines.length === 0) lines.push("Nessuna operazione nel documento OpenAPI.");
  if (doc.operations.length > ops.length) {
    lines.push(`[...altre ${doc.operations.length - ops.length} operazioni non mostrate]`);
  }
  return {
    content: capOutput(lines.join("\n")),
    log: `list_operations (${plural(doc.operations.length, "operazione", "operazioni")})`,
  };
}

async function runReadTool(
  name: ReadToolName,
  args: Record<string, unknown>,
  tree: SourceTree | null,
  openapi: OpenApiDoc | null,
): Promise<ToolOutput> {
  const a = args as Record<string, never>;
  switch (name) {
    case "list_dir":
      return listDir(tree!, a.path, a.depth);
    case "read_file":
      return readFile(tree!, a.path, a.fromLine, a.toLine);
    case "search":
      return search(tree!, a.pattern, a.glob, a.regex);
    case "list_operations":
      return listOperations(openapi!);
    case "read_operation": {
      const method = String(a.method).toUpperCase();
      return {
        content: capOutput(describeOperation(openapi!, method, a.path)),
        log: `read_operation ${logArg(method)} ${logArg(a.path)}`,
      };
    }
  }
}

/** Riga di log di una chiamata fallita, senza argomenti che potrebbero contenere dati. */
function errorLog(name: string, args: Record<string, unknown> | null): string {
  const target = args && typeof args["path"] === "string" ? ` ${logArg(args["path"] || "/")}` : "";
  const pattern = args && name === "search" && typeof args["pattern"] === "string" ? ` "${logArg(args["pattern"])}"` : "";
  return `${name}${target}${pattern} (errore)`;
}

/** Segnaposto di un output di lettura omesso: nome dello strumento e argomento principale, mai il contenuto. */
function omittedStub(name: ReadToolName, args: Record<string, unknown>): string {
  const str = (key: string): string => (typeof args[key] === "string" ? logArg(args[key] as string) : "");
  const target =
    name === "read_operation"
      ? `${str("method").toUpperCase()} ${str("path")}`
      : name === "search"
        ? `"${str("pattern")}"`
        : name === "list_operations"
          ? ""
          : str("path") || "/";
  return `[output di ${name}${target ? ` ${target}` : ""} omesso per spazio: rileggilo se serve]`;
}

/**
 * Compatta la cronologia prima di una chiamata al modello: senza, ogni giro rimanda tutti gli output
 * letti e i token crescono col quadrato dei giri. Restano intatti i messaggi di sistema, utente e
 * assistente (ogni tool_call conserva la sua unica risposta) e le risposte a submit_result; degli
 * output di lettura (indice del messaggio → segnaposto in `stubs`) restano interi i più recenti,
 * fino a `budget` caratteri in tutto (il più recente sempre), gli altri diventano il segnaposto.
 * Modifica `messages` sul posto: un output compattato resta tale.
 */
export function compactHistory(
  messages: ChatCompletionMessageParam[],
  stubs: Map<number, string>,
  budget = HISTORY_TOOL_OUTPUT_BUDGET,
): void {
  let kept = 0;
  let full = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const stub = stubs.get(i);
    if (m.role !== "tool" || stub === undefined || typeof m.content !== "string" || m.content === stub) continue;
    const size = m.content.length;
    if (!full && (kept === 0 || kept + size <= budget)) {
      kept += size;
      continue;
    }
    full = true;
    if (size > stub.length) messages[i] = { role: "tool", tool_call_id: m.tool_call_id, content: stub };
  }
}

// --- Ciclo -----------------------------------------------------------------------------------

const REMINDER =
  "Non hai chiamato nessuno strumento. Continua l'analisi con gli strumenti di lettura oppure, se hai finito, consegna l'esito con submit_result.";

export async function runPhase(input: RunPhaseInput): Promise<PhaseOutcome> {
  const { phase, tree, openapi, budget, log } = input;
  const now = input.now ?? Date.now;
  const tools = phaseTools(tree !== null, openapi !== null);
  const available = new Set(tools.map((t) => t.function.name));
  const schema = PHASE_SCHEMAS[phase];
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.user },
  ];
  // Indici dei messaggi con un output di lettura compattabile → segnaposto
  const stubs = new Map<number, string>();
  const fail = (error: string): PhaseOutcome => ({ ok: false, error: sliceChars(error, MAX_ERROR_CHARS) });

  let rounds = 0;
  let invalidSubmits = 0;

  for (;;) {
    // Limiti, controllati prima di ogni chiamata al modello
    if (rounds >= PHASE_MAX_ROUNDS) {
      return fail(`fase ${phase}: superato il limite di ${PHASE_MAX_ROUNDS} giri senza una consegna valida`);
    }
    if (budget.tokensUsed >= budget.maxTokens) {
      return fail(`fase ${phase}: budget di token dell'analisi esaurito (${budget.tokensUsed}/${budget.maxTokens})`);
    }
    if (now() >= budget.deadline) {
      return fail(`fase ${phase}: tempo massimo dell'analisi scaduto`);
    }

    rounds += 1;
    let reply: ChatResult;
    try {
      compactHistory(messages, stubs);
      reply = await input.chat(messages, tools);
    } catch (err) {
      return fail(`fase ${phase}: errore nella chiamata al modello: ${err instanceof Error ? err.message : String(err)}`);
    }
    budget.tokensUsed += reply.promptTokens + reply.completionTokens;

    if (reply.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: reply.content ?? "" });
      messages.push({ role: "user", content: REMINDER });
      log("nessuno strumento chiamato: promemoria per submit_result");
      continue;
    }

    messages.push({
      role: "assistant",
      content: reply.content,
      tool_calls: reply.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    });
    const answer = (id: string, content: string, stub?: string): void => {
      if (stub !== undefined) stubs.set(messages.length, stub);
      messages.push({ role: "tool", tool_call_id: id, content });
    };

    // Prima le letture (nell'ordine del modello), poi le consegne
    const reads = reply.toolCalls.filter((c) => c.name !== SUBMIT_TOOL.function.name);
    const submits = reply.toolCalls.filter((c) => c.name === SUBMIT_TOOL.function.name);

    for (const c of reads) {
      if (!available.has(c.name)) {
        answer(c.id, `Errore: lo strumento "${c.name}" non esiste o non è disponibile in questa analisi.`);
        log(`${logArg(c.name)} (strumento non disponibile)`);
        continue;
      }
      const name = c.name as ReadToolName;
      const parsed = parseArgs(name, c.arguments);
      const argError = parsed.ok ? checkArgs(name, parsed.args, READ_SPECS[name]) : parsed.error;
      if (argError || !parsed.ok) {
        answer(c.id, `Errore: ${argError}`);
        log(`${name} (argomenti non validi)`);
        continue;
      }
      try {
        const out = await runReadTool(name, parsed.args, tree, openapi);
        answer(c.id, out.content, omittedStub(name, parsed.args));
        log(out.log);
      } catch (err) {
        // Gli errori del sorgente (percorso inesistente, regex non valida...) tornano al modello
        const message = err instanceof SourceTreeError ? err.message : "lettura non riuscita";
        answer(c.id, `Errore: ${message}`);
        log(errorLog(name, parsed.args));
      }
    }

    for (const c of submits) {
      const parsed = parseArgs(c.name, c.arguments);
      let problems: string[];
      if (!parsed.ok) {
        problems = [parsed.error];
      } else if (!("result" in parsed.args)) {
        problems = ["result: campo obbligatorio (l'esito va passato come { \"result\": { ... } })"];
      } else {
        const r = schema.safeParse(parsed.args["result"]);
        if (r.success) {
          log("submit_result valido");
          return { ok: true, result: r.data };
        }
        problems = formatIssues(r.error.issues);
      }

      invalidSubmits += 1;
      if (invalidSubmits > MAX_CORRECTIONS) {
        log("submit_result non valido (correzioni esaurite)");
        return fail(`esito della fase ${phase} non valido dopo ${MAX_CORRECTIONS} correzioni: ${problems.join("; ")}`);
      }
      answer(
        c.id,
        `Esito non valido (correzione ${invalidSubmits}/${MAX_CORRECTIONS}): correggi questi problemi e richiama submit_result con l'esito completo, rispettando esattamente la forma dell'esempio della fase.\n- ${problems.join("\n- ")}`,
      );
      log(`submit_result non valido (correzione ${invalidSubmits}/${MAX_CORRECTIONS})`);
    }
  }
}

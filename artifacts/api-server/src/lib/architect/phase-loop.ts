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
import { assistantToolCalls, type ChatResult } from "../ai-gateway";
import { PHASE_SCHEMAS, type PhaseName } from "./schemas";
import { SOURCE_LIMITS, SourceTreeError, type SourceTree } from "./source-tree";
import { describeOperation, type OpenApiDoc } from "./sources";
import { sliceChars } from "./text";

export const PHASE_MAX_ROUNDS = 25;
export const MAX_CORRECTIONS = 2;

/**
 * Quota del tetto di token dell'analisi assegnata a ogni fase. È una quota morbida: serve solo a
 * sollecitare la consegna; i token non usati da una fase restano alle successive e l'unico limite
 * rigido è il tetto complessivo dell'analisi. La somma (0,88) resta volutamente sotto 1: i giri di
 * margine dopo il sollecito e le correzioni consumano altri token, e così l'ultima fase non trova il
 * tetto complessivo già esaurito.
 */
export const PHASE_TOKEN_SHARES: Record<PhaseName, number> = {
  map: 0.22,
  capabilities: 0.13,
  catalog: 0.18,
  agents: 0.13,
  completion: 0.13,
  evolution: 0.09,
};

/** Frazione della quota di token (o dei giri) oltre la quale si sollecita la consegna. */
export const PHASE_NUDGE_RATIO = 0.8;
/** Giri concessi dopo il sollecito prima che la fase fallisca. */
export const PHASE_NUDGE_GRACE_ROUNDS = 2;
export const PHASE_NUDGE =
  "Budget della fase quasi esaurito: consegna ora l'esito con submit_result usando quello che hai già letto.";

// Tetti sul testo restituito al modello per ogni chiamata
export const MAX_TOOL_OUTPUT_CHARS = 12_000;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 200;
// Spazio lasciato, sotto il tetto dell'output, al suggerimento finale (es. come continuare)
const HINT_RESERVE_CHARS = 300;
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
export const HISTORY_TOOL_OUTPUT_BUDGET = 24_000;

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
  /**
   * Quota morbida di token della fase (di solito `PHASE_TOKEN_SHARES[fase] × maxTokens`): all'80%
   * il modello riceve il sollecito a consegnare. Senza quota il sollecito scatta solo per i giri.
   */
  phaseQuota?: number;
  log: (message: string) => void;
  now?: () => number;
}

export type PhaseOutcome = { ok: true; result: unknown } | { ok: false; error: string };

export type ReadToolName = "list_dir" | "read_file" | "search" | "list_operations" | "read_operation";

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
  list_operations: fn(
    "list_operations",
    "Elenca le operazioni del contratto OpenAPI, ordinate per percorso e metodo: METODO percorso — operationId — summary. L'elenco è a pagine: se ci sono altre operazioni, l'ultima riga indica l'offset da usare.",
    {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Solo le operazioni il cui percorso inizia così, es. /api/squadre" },
        offset: { type: "integer", description: "Operazioni da saltare (dopo il filtro), per la pagina successiva (default 0)" },
      },
    },
  ),
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
  list_operations: { prefix: { type: "string" }, offset: { type: "integer" } },
  read_operation: { method: { type: "string", required: true }, path: { type: "string", required: true } },
};

/**
 * Quante righe, dall'inizio, entrano nel tetto dell'output lasciando spazio a un suggerimento finale:
 * si taglia prima di aggiungere il suggerimento, così il suggerimento non viene mai troncato.
 */
function fittingLines(lines: string[], limit = MAX_TOOL_OUTPUT_CHARS - HINT_RESERVE_CHARS): number {
  let chars = 0;
  for (let i = 0; i < lines.length; i++) {
    chars += lines[i]!.length + 1;
    if (chars > limit) return i;
  }
  return lines.length;
}

function listDir(tree: SourceTree, path: string, depth: number | undefined): ToolOutput {
  const entries = tree.list(path, depth ?? 1);
  const shown = entries.slice(0, Math.min(MAX_LIST_ENTRIES, fittingLines(entries)));
  const lines = shown.length ? shown : ["(cartella vuota)"];
  if (entries.length > shown.length) {
    lines.push(`[...altre ${entries.length - shown.length} voci non mostrate: elenca una sottocartella o riduci depth]`);
  }
  return {
    content: capOutput(lines.join("\n")),
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
  const all = results.slice(0, MAX_SEARCH_MATCHES).map((r) => `${r.path}:${r.line}: ${r.text}`);
  const lines = all.slice(0, fittingLines(all));
  if (all.length === 0) lines.push("Nessun risultato.");
  if (lines.length < all.length || results.length >= Math.min(SOURCE_LIMITS.maxSearchResults, MAX_SEARCH_MATCHES)) {
    lines.push(`[risultati limitati a ${lines.length}: restringi la ricerca con glob o un pattern più specifico]`);
  }
  return {
    content: capOutput(lines.join("\n")),
    log: `search "${logArg(pattern)}"${regex ? " (regex)" : ""} (${plural(results.length, "risultato", "risultati")})`,
  };
}

/**
 * Operazioni del contratto a pagine (già ordinate per percorso e metodo da `fetchOpenApi`): filtro
 * per prefisso del percorso, poi `offset` operazioni saltate, poi quante ne entrano nel tetto
 * dell'output; se ne restano, l'ultima riga dice come continuare.
 */
function listOperations(doc: OpenApiDoc, prefix: string | undefined, offset: number | undefined): ToolOutput {
  const filtered = prefix ? doc.operations.filter((op) => op.path.startsWith(prefix)) : doc.operations;
  const from = Math.max(Math.trunc(offset ?? 0), 0);
  const all = filtered.slice(from).map((op) =>
    [
      `${op.method.toUpperCase()} ${op.path}`,
      op.operationId,
      op.summary ? sliceChars(op.summary.replace(/\s+/g, " "), MAX_SUMMARY_CHARS) : null,
    ]
      .filter(Boolean)
      .join(" — "),
  );
  const lines = all.slice(0, fittingLines(all));
  const shown = lines.length;
  const rest = all.length - shown;
  const where = prefix ? ` con prefisso ${logArg(prefix)}` : "";
  if (filtered.length === 0) lines.push(`Nessuna operazione${where} nel documento OpenAPI.`);
  else if (shown === 0) lines.push(`Nessuna operazione${where} oltre offset=${from} (sono ${filtered.length}).`);
  else if (from > 0 || rest > 0) lines.unshift(`Operazioni${where} ${from + 1}-${from + shown} di ${filtered.length}:`);
  if (rest > 0) lines.push(`[altre ${rest} operazioni: usa offset=${from + shown} o un prefix]`);
  return {
    content: capOutput(lines.join("\n")),
    log: `list_operations${prefix ? ` ${logArg(prefix)}` : ""}${from ? ` offset=${from}` : ""} (${plural(filtered.length, "operazione", "operazioni")})`,
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
      return listOperations(openapi!, a.prefix, a.offset);
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

/** Esito di una lettura: testo per il modello, riga di log e se la lettura è riuscita (compattabile). */
type ReadOutcome = { content: string; log: string; ok: boolean };

/** Controlla gli argomenti ed esegue la lettura; gli errori tornano come testo, mai come eccezione. */
async function performRead(
  name: ReadToolName,
  args: Record<string, unknown>,
  tree: SourceTree | null,
  openapi: OpenApiDoc | null,
): Promise<ReadOutcome> {
  const argError = checkArgs(name, args, READ_SPECS[name]);
  if (argError) return { content: `Errore: ${argError}`, log: `${name} (argomenti non validi)`, ok: false };
  try {
    const out = await runReadTool(name, args, tree, openapi);
    return { ...out, ok: true };
  } catch (err) {
    // Gli errori del sorgente (percorso inesistente, regex non valida...) tornano al modello
    const message = err instanceof SourceTreeError ? err.message : "lettura non riuscita";
    return { content: `Errore: ${message}`, log: errorLog(name, args), ok: false };
  }
}

const CODE_TOOLS: ReadonlySet<string> = new Set(["list_dir", "read_file", "search"]);

/**
 * Strumento di lettura per chi non passa da `runPhase` (l'agente locale via MCP): stesso testo restituito al
 * modello, stessa riga di log (se `ctx.log` c'è). Uno strumento senza la sua sorgente, o argomenti che non sono
 * un oggetto, danno lo stesso errore che riceverebbe il modello.
 */
export async function executeReadTool(
  name: ReadToolName,
  args: unknown,
  ctx: { tree: SourceTree | null; openapi: OpenApiDoc | null; log?: (message: string) => void },
): Promise<string> {
  const available = CODE_TOOLS.has(name) ? ctx.tree !== null : ctx.openapi !== null;
  if (!(name in READ_SPECS) || !available) {
    ctx.log?.(`${logArg(String(name))} (strumento non disponibile)`);
    return `Errore: lo strumento "${name}" non esiste o non è disponibile in questa analisi.`;
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    ctx.log?.(`${name} (argomenti non validi)`);
    return `Errore: gli argomenti di "${name}" devono essere un oggetto JSON`;
  }
  const out = await performRead(name, args as Record<string, unknown>, ctx.tree, ctx.openapi);
  ctx.log?.(out.log);
  return out.content;
}

type SubmitCheck = { ok: true; result: unknown } | { ok: false; problems: string[] };

function checkSubmit(phase: PhaseName, raw: unknown): SubmitCheck {
  const r = PHASE_SCHEMAS[phase].safeParse(raw);
  return r.success ? { ok: true, result: r.data } : { ok: false, problems: formatIssues(r.error.issues) };
}

/** Valida l'esito di una fase con lo schema Zod della fase; i problemi sono righe "- campo: messaggio". */
export function validatePhaseSubmit(
  phase: PhaseName,
  raw: unknown,
): { ok: true; result: unknown } | { ok: false; issues: string } {
  const r = checkSubmit(phase, raw);
  return r.ok ? r : { ok: false, issues: r.problems.map((p) => `- ${p}`).join("\n") };
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
          ? [str("prefix"), Number.isInteger(args["offset"]) ? `offset=${String(args["offset"])}` : ""].filter(Boolean).join(" ")
          : str("path") || "/";
  return `[output di ${name}${target ? ` ${target}` : ""} omesso per spazio: rileggilo se serve]`;
}

/**
 * Compatta la cronologia prima di una chiamata al modello: senza, ogni giro rimanda tutti gli output
 * letti e i token crescono col quadrato dei giri. Restano intatti i messaggi di sistema, utente e
 * assistente (ogni tool_call conserva la sua unica risposta) e le risposte a submit_result; degli
 * output di lettura (indice del messaggio → segnaposto in `stubs`) restano interi i più recenti,
 * fino a `budget` caratteri in tutto, gli altri diventano il segnaposto. Gli output del giro corrente
 * (dopo l'ultimo messaggio dell'assistente) restano sempre interi: il modello non li ha ancora visti.
 * Modifica `messages` sul posto: un output compattato resta tale.
 */
export function compactHistory(
  messages: ChatCompletionMessageParam[],
  stubs: Map<number, string>,
  budget = HISTORY_TOOL_OUTPUT_BUDGET,
): void {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  let kept = 0;
  let full = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const stub = stubs.get(i);
    if (m.role !== "tool" || stub === undefined || typeof m.content !== "string" || m.content === stub) continue;
    const size = m.content.length;
    if (i > lastAssistant || (!full && (kept === 0 || kept + size <= budget))) {
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
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.user },
  ];
  // Indici dei messaggi con un output di lettura compattabile → segnaposto
  const stubs = new Map<number, string>();
  const fail = (error: string): PhaseOutcome => ({ ok: false, error: sliceChars(error, MAX_ERROR_CHARS) });

  let rounds = 0;
  let invalidSubmits = 0;
  // Problemi dell'ultima consegna non valida e se è avvenuta nell'ultimo giro
  let lastProblems: string[] | null = null;
  let lastRoundInvalidSubmit = false;
  // Token usati da questa fase (il budget dell'analisi è cumulativo tra le fasi)
  let phaseTokens = 0;
  // Giro dopo il quale è stato inviato il sollecito a consegnare (null = non ancora)
  let nudgedAt: number | null = null;
  const quota = input.phaseQuota ?? Number.POSITIVE_INFINITY;
  const nudgeRounds = Math.ceil(PHASE_MAX_ROUNDS * PHASE_NUDGE_RATIO);

  /**
   * A fine giro, una sola volta: oltre l'80% della quota o dei giri chiede la consegna. Il sollecito è
   * un messaggio utente aggiunto dopo tutte le risposte agli strumenti del giro, così ogni tool_call
   * resta seguita dalle sue risposte. Restituisce il testo da inviare, o null se non serve.
   */
  const nudgeNow = (): string | null => {
    if (nudgedAt !== null) return null;
    if (phaseTokens < quota * PHASE_NUDGE_RATIO && rounds < nudgeRounds) return null;
    nudgedAt = rounds;
    log("budget della fase quasi esaurito: sollecito a consegnare");
    return PHASE_NUDGE;
  };

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
    // Margine dopo il sollecito: se l'ultimo giro è finito con una consegna non valida e restano
    // correzioni, il modello può ancora correggerla (lo limitano il tetto di token e i giri)
    const correcting = lastRoundInvalidSubmit && invalidSubmits <= MAX_CORRECTIONS;
    if (nudgedAt !== null && rounds - nudgedAt >= PHASE_NUDGE_GRACE_ROUNDS && !correcting) {
      const detail = lastProblems ? `; ultimo esito non valido: ${lastProblems.join("; ")}` : "";
      return fail(`fase ${phase}: esito non consegnato entro il budget della fase${detail}`);
    }

    rounds += 1;
    let reply: ChatResult;
    try {
      compactHistory(messages, stubs);
      reply = await input.chat(messages, tools);
    } catch (err) {
      return fail(`fase ${phase}: errore nella chiamata al modello: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Si contano solo le chiamate riuscite: di quelle fallite o scadute il provider non riporta
    // l'uso, quindi i loro token (se ce ne sono) restano fuori dal budget
    const used = reply.promptTokens + reply.completionTokens;
    budget.tokensUsed += used;
    phaseTokens += used;
    lastRoundInvalidSubmit = false;

    if (reply.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: reply.content ?? "" });
      // Un solo messaggio utente: il sollecito, se dovuto, prende il posto del promemoria
      messages.push({ role: "user", content: nudgeNow() ?? REMINDER });
      log("nessuno strumento chiamato: promemoria per submit_result");
      continue;
    }

    messages.push({
      role: "assistant",
      content: reply.content,
      tool_calls: assistantToolCalls(reply.toolCalls),
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
      if (!parsed.ok) {
        answer(c.id, `Errore: ${parsed.error}`);
        log(`${name} (argomenti non validi)`);
        continue;
      }
      const out = await performRead(name, parsed.args, tree, openapi);
      answer(c.id, out.content, out.ok ? omittedStub(name, parsed.args) : undefined);
      log(out.log);
    }

    for (const c of submits) {
      const parsed = parseArgs(c.name, c.arguments);
      let problems: string[];
      if (!parsed.ok) {
        problems = [parsed.error];
      } else if (!("result" in parsed.args)) {
        problems = ["result: campo obbligatorio (l'esito va passato come { \"result\": { ... } })"];
      } else {
        const r = checkSubmit(phase, parsed.args["result"]);
        if (r.ok) {
          log("submit_result valido");
          return { ok: true, result: r.result };
        }
        problems = r.problems;
      }

      invalidSubmits += 1;
      lastProblems = problems;
      lastRoundInvalidSubmit = true;
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

    const nudge = nudgeNow();
    if (nudge) messages.push({ role: "user", content: nudge });
  }
}

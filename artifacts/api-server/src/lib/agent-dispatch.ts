// Smistamento di una singola tool call dell'agente: prepara, esegue o accoda, scrive il passo e
// restituisce il testo che il modello riceve come messaggio `tool`. Condiviso dal ciclo dell'agente
// (`runAgentLoop`) e dal dispatcher delle run delegate al nodo. Modulo puro: niente DB né rete.

import { validateArgs } from "./tools/definition";
import { effectiveLevel } from "./tools/levels";
import type { CatalogTool, ToolResult } from "./tools/types";
import type { LoopDeps, QueueActionResult, StepRecord, ToolCall } from "./agent-loop";

/** Parametri che Casello aggiunge agli strumenti L2: servono alla coda, non arrivano al servizio. */
export const RECIPIENT_PARAM = "destinatario";
export const SUMMARY_PARAM = "sintesi";
export const MAX_SUMMARY_CHARS = 500;

export const QUEUE_FIELDS_MISSING = "servono destinatario e sintesi per un'azione da confermare";
export const QUEUE_FAILED = "impossibile accodare l'azione";

export function queuedMessage(number: number): string {
  return `accodata come n. ${number}, in attesa di conferma dell'utente`;
}


// Esito della preparazione di una chiamata: errore da restituire al modello, tool pronto da eseguire
// o azione L2 da accodare
export type PreparedCall =
  | { kind: "error"; call: ToolCall; args: unknown; message: string }
  | { kind: "ready"; call: ToolCall; tool: CatalogTool; args: Record<string, unknown> }
  | {
      kind: "queue";
      call: ToolCall;
      tool: CatalogTool;
      args: Record<string, unknown>;
      recipient: string;
      summary: string;
    };

export function prepareCall(call: ToolCall, tools: CatalogTool[]): PreparedCall {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    return { kind: "error", call, args: call.arguments, message: `Errore: lo strumento "${call.name}" non esiste` };
  }
  // Alcuni modelli inviano una stringa vuota quando non ci sono argomenti
  const raw = call.arguments.trim() === "" ? "{}" : call.arguments;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      kind: "error",
      call,
      args: call.arguments,
      message: `Errore: gli argomenti di "${call.name}" non sono JSON valido`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "error",
      call,
      args: parsed,
      message: `Errore: gli argomenti di "${call.name}" devono essere un oggetto JSON`,
    };
  }
  const { [RECIPIENT_PARAM]: recipient, [SUMMARY_PARAM]: summary, ...rest } = parsed as Record<string, unknown>;

  if (effectiveLevel(tool) !== "L2") {
    // Destinatario e sintesi superflui si tolgono, a meno che lo strumento non li dichiari come suoi
    const declared = declaredParams(tool.paramsSchema);
    const args = { ...rest };
    if (recipient !== undefined && declared.has(RECIPIENT_PARAM)) args[RECIPIENT_PARAM] = recipient;
    if (summary !== undefined && declared.has(SUMMARY_PARAM)) args[SUMMARY_PARAM] = summary;
    return { kind: "ready", call, tool, args };
  }

  if (
    typeof recipient !== "string" ||
    typeof summary !== "string" ||
    recipient.trim() === "" ||
    summary.trim() === ""
  ) {
    return { kind: "error", call, args: rest, message: QUEUE_FIELDS_MISSING };
  }
  if (summary.length > MAX_SUMMARY_CHARS) {
    return { kind: "error", call, args: rest, message: `la sintesi supera i ${MAX_SUMMARY_CHARS} caratteri` };
  }
  const argError = validateArgs(tool.paramsSchema, rest);
  if (argError) return { kind: "error", call, args: rest, message: `argomenti non validi: ${argError}` };
  return { kind: "queue", call, tool, args: rest, recipient, summary };
}

function declaredParams(schema: Record<string, unknown>): Set<string> {
  const props = schema["properties"];
  return new Set(props && typeof props === "object" && !Array.isArray(props) ? Object.keys(props) : []);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ReadyCall = Extract<PreparedCall, { kind: "ready" }>;
type QueueCall = Extract<PreparedCall, { kind: "queue" }>;

/** Passo di una preparazione fallita. */
export function errorStep(p: Extract<PreparedCall, { kind: "error" }>): StepRecord {
  return { type: "tool", toolName: p.call.name, args: p.args, ok: false, durationMs: 0, error: p.message };
}

/** Esegue un tool già preparato; un'eccezione diventa un errore per il modello. */
export async function executePrepared(
  p: ReadyCall,
  executeTool: LoopDeps["executeTool"],
  now: () => number,
): Promise<{ result: ToolResult; durationMs: number }> {
  const t0 = now();
  let result: ToolResult;
  try {
    result = await executeTool(p.tool, p.args);
  } catch (err) {
    result = { ok: false, content: `Errore durante l'esecuzione di "${p.tool.name}": ${errorMessage(err)}` };
  }
  return { result, durationMs: now() - t0 };
}

export function toolStep(p: ReadyCall, result: ToolResult, durationMs: number): StepRecord {
  return {
    type: "tool",
    toolName: p.tool.name,
    args: p.args,
    ok: result.ok,
    httpStatus: result.status,
    durationMs,
    error: result.ok ? undefined : result.content,
  };
}

/** Accoda un'azione L2: testo per il modello (numero della voce o motivo del rifiuto) e passo da scrivere. */
export async function enqueuePrepared(
  p: QueueCall,
  queueAction: LoopDeps["queueAction"],
  now: () => number,
): Promise<{ text: string; step: StepRecord }> {
  const t0 = now();
  let outcome: QueueActionResult;
  try {
    outcome = await queueAction(p.tool, p.args, p.recipient, p.summary);
  } catch {
    outcome = { ok: false, message: QUEUE_FAILED };
  }
  const durationMs = now() - t0;
  if (outcome.ok) {
    return {
      text: queuedMessage(outcome.number),
      step: {
        type: "queued",
        toolName: p.tool.name,
        args: p.args,
        ok: true,
        durationMs,
        queuedNumber: outcome.number,
        recipient: p.recipient,
        summary: p.summary,
      },
    };
  }
  return {
    text: outcome.message,
    step: { type: "tool", toolName: p.tool.name, args: p.args, ok: false, durationMs, error: outcome.message },
  };
}

/**
 * Smista una chiamata come farebbe il ciclo dell'agente e restituisce il testo del messaggio `tool`.
 * Scrive gli stessi passi (`tool`, `queued`, errore) di `runAgentLoop`.
 */
export async function dispatchAgentCall(
  call: ToolCall,
  deps: Pick<LoopDeps, "tools" | "executeTool" | "queueAction" | "onStep">,
  now: () => number = Date.now,
): Promise<string> {
  const prepared = prepareCall(call, deps.tools);
  if (prepared.kind === "error") {
    await deps.onStep(errorStep(prepared));
    return prepared.message;
  }
  if (prepared.kind === "queue") {
    const { text, step } = await enqueuePrepared(prepared, deps.queueAction, now);
    await deps.onStep(step);
    return text;
  }
  const { result, durationMs } = await executePrepared(prepared, deps.executeTool, now);
  await deps.onStep(toolStep(prepared, result, durationMs));
  return result.content;
}

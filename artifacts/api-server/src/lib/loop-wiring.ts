import { APIConnectionTimeoutError, APIUserAbortError } from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ChatResult } from "./ai/chat-types";
import { ProviderError } from "./ai/discovery";
import { ModelAccessError, modelChat, resolveModel, type ResolvedModel } from "./ai/executor";
import type { LoopDeps, StepRecord } from "./agent-loop";
import { logger } from "./logger";
import { stepArgsWithSchema } from "./tools/sensitive";

// Collegamenti comuni tra il ciclo dell'agente (puro) e chi lo esegue (run, compiti e turni delle squadre):
// chiamata al modello con token e costo, scrittura dei passi con gli argomenti oscurati.

// Tempo minimo concesso a una chiamata al modello, anche a turno quasi esaurito
export const MIN_MODEL_CALL_MS = 1_000;

/**
 * Uso di un'esecuzione: token e costo sommati chiamata per chiamata. Il costo è parziale se almeno una
 * chiamata con token non ha un costo (prezzo mancante).
 */
export interface LoopUsage {
  promptTokens: number;
  completionTokens: number;
  /** Token di prompt letti dalla cache (già compresi in `promptTokens`) */
  cachedTokens: number;
  costUsd: number;
  costPartial: boolean;
}

export function newUsage(): LoopUsage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, costPartial: false };
}

export function addUsage(usage: LoopUsage, reply: ChatResult & { costUsd?: number | null }): void {
  usage.promptTokens += reply.promptTokens;
  usage.completionTokens += reply.completionTokens;
  usage.cachedTokens += reply.cachedPromptTokens;
  const tokens = reply.promptTokens + reply.completionTokens;
  if (reply.costUsd == null) {
    if (tokens > 0) usage.costPartial = true;
  } else {
    usage.costUsd += reply.costUsd;
  }
}

/** Costo per la colonna numeric: null se nessuna chiamata ha consumato token o se il costo è parziale. */
export function usageCost(usage: LoopUsage): string | null {
  if (usage.costPartial) return null;
  if (usage.promptTokens + usage.completionTokens === 0) return null;
  if (!Number.isFinite(usage.costUsd)) return null;
  return String(Math.round(usage.costUsd * 1e8) / 1e8);
}

const MODEL_TIMEOUT_MESSAGE = "il modello non ha risposto in tempo";
const MODEL_UNEXPECTED_MESSAGE = "errore inatteso nella chiamata al modello";

/**
 * Errore di una chiamata all'esecutore dei modelli → messaggio italiano fisso (mai quello grezzo
 * dell'SDK o del provider, che può contenere URL o il corpo della risposta).
 */
function modelErrorMessage(err: unknown): string {
  if (err instanceof ProviderError || err instanceof ModelAccessError) return err.message;
  if (err instanceof APIConnectionTimeoutError || err instanceof APIUserAbortError) return MODEL_TIMEOUT_MESSAGE;
  return MODEL_UNEXPECTED_MESSAGE;
}

/**
 * Errore da rilanciare al ciclo per una chiamata al modello fallita. Un errore inatteso si registra nel
 * log con il contesto e il solo tipo (`errName`): il messaggio grezzo può contenere URL, chiave o corpo del provider.
 */
export function loopModelCallError(logContext: Record<string, unknown>, err: unknown): Error {
  const message = modelErrorMessage(err);
  if (message === MODEL_UNEXPECTED_MESSAGE) {
    const errName = err instanceof Error ? err.name : typeof err;
    logger.warn({ ...logContext, errName }, "Errore inatteso nella chiamata al modello");
  }
  return new Error(message);
}

export interface ModelChatDepsInput {
  aiModelId: number;
  /** Strumenti offerti al modello (function calling) */
  functionTools: ChatCompletionTool[];
  /** Servizio chiamante, per i log */
  caller: string;
  usage: LoopUsage;
  /** Annullamento dall'esterno: interrompe la chiamata in volo */
  signal: AbortSignal;
  /** Contesto dei log degli errori inattesi (es. `{ runId }`, `{ teamTaskId }`) */
  logContext: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  /** Modello già risolto da chi chiama (stesso `aiModelId`): evita una seconda lettura. */
  resolved?: ResolvedModel;
}

/**
 * `LoopDeps["chat"]` sul modello indicato. Il modello si risolve una volta, alla prima chiamata, così un errore
 * di risoluzione diventa un passo `model` fallito come gli altri; il risultato (con la chiave in memoria) non si
 * copia mai. Ogni chiamata è limitata dal tempo attivo rimasto (minimo 1 s); token e costo vanno in `usage`. Una
 * chiamata interrotta dall'annullamento rende il costo parziale (l'uso è ignoto).
 */
export function modelChatDeps(input: ModelChatDepsInput): LoopDeps["chat"] {
  let resolved: Promise<ResolvedModel> | null = null;
  return async (messages, { remainingMs }) => {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(Math.max(MIN_MODEL_CALL_MS, remainingMs))]);
    try {
      resolved ??= input.resolved ? Promise.resolve(input.resolved) : resolveModel(input.aiModelId, { userId: null, mustOwn: false });
      const reply = await modelChat(await resolved, {
        messages,
        tools: input.functionTools,
        caller: input.caller,
        maxTokens: input.maxTokens ?? 2000,
        temperature: input.temperature ?? 0.3,
        signal,
      });
      addUsage(input.usage, reply);
      return reply;
    } catch (err) {
      if (input.signal.aborted) input.usage.costPartial = true;
      throw loopModelCallError(input.logContext, err);
    }
  };
}

/** Riga di un passo (`run_steps`, `team_task_steps`, `team_turn_steps`) senza la chiave dell'esecuzione. */
export interface StepRow {
  position: number;
  type: string;
  toolName: string | null;
  args: unknown;
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
  /** Solo se il passo ha una nota (colonna di `run_steps`). */
  note?: string;
}

/**
 * Argomenti di un passo, oscurati con lo schema dei parametri dello strumento. `paramsSchema` null = strumento
 * sconosciuto: gli argomenti non si registrano. Un'azione accodata registra numero, destinatario, sintesi e argomenti.
 */
export function stepRowArgs(step: StepRecord, paramsSchema: unknown | null): unknown {
  const toolArgs = step.args === undefined || !step.toolName || paramsSchema === null ? null : stepArgsWithSchema(paramsSchema, step.args);
  if (step.type !== "queued") return toolArgs;
  return {
    numero: step.queuedNumber ?? null,
    destinatario: step.recipient ?? null,
    sintesi: step.summary ?? null,
    argomenti: toolArgs,
  };
}

/**
 * Scrittore dei passi con posizioni crescenti da `startPosition`. `schemaFor` dà lo schema dei parametri dello
 * strumento del passo (null se sconosciuto); `insert` scrive la riga.
 */
export function stepWriter(
  insert: (row: StepRow) => Promise<unknown>,
  schemaFor: (toolName: string) => unknown | null | Promise<unknown | null>,
  startPosition = 0,
): (step: StepRecord) => Promise<void> {
  let position = startPosition;
  return async (step) => {
    const schema = step.toolName && step.args !== undefined ? await schemaFor(step.toolName) : null;
    await insert({
      position: position++,
      type: step.type,
      toolName: step.toolName ?? null,
      args: stepRowArgs(step, schema),
      ok: step.ok,
      httpStatus: step.httpStatus ?? null,
      durationMs: Math.round(step.durationMs),
      error: step.error ?? null,
      ...(step.note !== undefined ? { note: step.note } : {}),
    });
  };
}

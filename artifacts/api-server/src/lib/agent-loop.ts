// Ciclo dell'agente: alterna chiamate al modello ed esecuzioni dei tool e applica i limiti del turno.
// Le chiamate ai tool L2 non si eseguono: diventano voci della coda delle azioni (`queueAction`) e il
// modello riceve il numero della voce. Modulo puro: niente DB né rete, tutte le dipendenze arrivano da
// `LoopDeps`. Lo stato (`LoopState`) è JSON puro.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { assistantToolCalls, type ChatResult } from "./ai/chat-types";
import {
  RECIPIENT_PARAM, SUMMARY_PARAM, MAX_SUMMARY_CHARS, QUEUE_FIELDS_MISSING, QUEUE_FAILED, queuedMessage,
  prepareCall, errorStep, executePrepared, toolStep, enqueuePrepared, errorMessage, type PreparedCall,
} from "./agent-dispatch";
import { effectiveLevel } from "./tools/levels";
import type { CatalogTool, ToolResult } from "./tools/types";

export interface LoopLimits {
  maxRounds: number;
  maxActiveMs: number;
  maxTokens: number;
}

// Confronto con `>=`: il limite è raggiunto al valore indicato
// (es. con maxRounds 8 la nona chiamata al modello non parte; con 60 000 token esatti il turno si ferma)
/** Errore della run quando il modello si ferma per il limite di token di uscita senza chiamare strumenti. */
export const TRUNCATED_REPLY_ERROR = "risposta del modello troncata: limite di token di uscita raggiunto";

export const DEFAULT_LIMITS: LoopLimits = { maxRounds: 8, maxActiveMs: 120_000, maxTokens: 60_000 };

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LoopState {
  messages: ChatCompletionMessageParam[];
  /** Chiamate del messaggio assistente precedente non ancora eseguite */
  queue: ToolCall[];
  /** Chiamate al modello che hanno restituito tool */
  rounds: number;
  /** Token (prompt + completamento) di tutte le chiamate al modello del turno */
  tokens: number;
  /** Tempo passato dentro runAgentLoop */
  activeMs: number;
}

export interface StepRecord {
  type: "model" | "tool" | "queued";
  toolName?: string;
  args?: unknown;
  ok: boolean;
  httpStatus?: number;
  durationMs: number;
  error?: string;
  /** Solo per `queued`: numero della voce nella coda delle azioni dell'utente */
  queuedNumber?: number;
  /** Solo per `queued`: destinatario e sintesi dichiarati dal modello */
  recipient?: string;
  summary?: string;
}

export type QueueActionResult = { ok: true; number: number } | { ok: false; message: string };

export interface LoopDeps {
  /** `remainingMs`: tempo attivo ancora disponibile nel turno, per limitare la chiamata */
  chat(messages: ChatCompletionMessageParam[], opts: { remainingMs: number }): Promise<ChatResult>;
  tools: CatalogTool[];
  executeTool(tool: CatalogTool, args: Record<string, unknown>): Promise<ToolResult>;
  /** Accoda una chiamata L2 per la conferma dell'utente (argomenti senza destinatario e sintesi) */
  queueAction(
    tool: CatalogTool,
    args: Record<string, unknown>,
    recipient: string,
    summary: string,
  ): Promise<QueueActionResult>;
  onStep(step: StepRecord): Promise<void>;
  limits?: Partial<LoopLimits>;
  now?: () => number;
  /** Annullamento: se scatta, il ciclo non inizia nuovi giri e si chiude come `cancelled` */
  signal?: AbortSignal;
}

export type LoopOutcome =
  | { type: "finished"; content: string; state: LoopState }
  | { type: "failed"; error: string; state: LoopState }
  /** Annullato dall'esterno (`deps.signal`): niente altri passi, lo stato della run lo scrive chi ha annullato */
  | { type: "cancelled"; state: LoopState };

export { RECIPIENT_PARAM, SUMMARY_PARAM, MAX_SUMMARY_CHARS, QUEUE_FIELDS_MISSING, QUEUE_FAILED, queuedMessage };

function cloneState(state: LoopState): LoopState {
  return JSON.parse(JSON.stringify(state)) as LoopState;
}

// Eseguibili in parallelo: sola lettura (L0), HTTP o MCP
function isParallelSafe(p: PreparedCall): p is Extract<PreparedCall, { kind: "ready" }> {
  return (
    p.kind === "ready" && effectiveLevel(p.tool) === "L0" && (p.tool.kind === "http" || p.tool.kind === "mcp")
  );
}

function toolMessage(toolCallId: string, content: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: toolCallId, content };
}

export async function runAgentLoop(initial: LoopState, deps: LoopDeps): Promise<LoopOutcome> {
  const limits: LoopLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const state = cloneState(initial);
  const startedAt = now();
  const baseActiveMs = state.activeMs;
  const syncActive = (): void => {
    state.activeMs = baseActiveMs + (now() - startedAt);
  };

  const finish = <T extends LoopOutcome>(outcome: T): T => {
    syncActive();
    return outcome;
  };

  // Esegue un tool già preparato; un'eccezione diventa un errore per il modello
  const execute = (p: Extract<PreparedCall, { kind: "ready" }>) => executePrepared(p, deps.executeTool, now);

  const record = async (p: Extract<PreparedCall, { kind: "ready" }>, result: ToolResult, durationMs: number) => {
    state.messages.push(toolMessage(p.call.id, result.content));
    await deps.onStep(toolStep(p, result, durationMs));
  };

  // Accoda un'azione L2: il modello riceve il numero della voce o il motivo del rifiuto
  const enqueue = async (p: Extract<PreparedCall, { kind: "queue" }>): Promise<void> => {
    const { text, step } = await enqueuePrepared(p, deps.queueAction, now);
    state.messages.push(toolMessage(p.call.id, text));
    await deps.onStep(step);
  };

  const cancelled = (): LoopOutcome | null =>
    deps.signal?.aborted ? finish({ type: "cancelled", state }) : null;

  for (;;) {
    // 1. Svuota la coda delle chiamate rimaste
    while (state.queue.length > 0) {
      if (deps.signal?.aborted) return finish({ type: "cancelled", state });
      const prepared = prepareCall(state.queue[0], deps.tools);

      if (prepared.kind === "error") {
        state.queue.shift();
        state.messages.push(toolMessage(prepared.call.id, prepared.message));
        await deps.onStep(errorStep(prepared));
        continue;
      }

      if (prepared.kind === "queue") {
        state.queue.shift();
        await enqueue(prepared);
        if (deps.signal?.aborted) return finish({ type: "cancelled", state });
        continue;
      }

      if (isParallelSafe(prepared)) {
        // Raccoglie le chiamate consecutive in sola lettura e le esegue insieme
        const group = [prepared];
        while (group.length < state.queue.length) {
          const next = prepareCall(state.queue[group.length], deps.tools);
          if (!isParallelSafe(next)) break;
          group.push(next);
        }
        state.queue.splice(0, group.length);
        const results = await Promise.all(group.map((p) => execute(p)));
        // Con l'annullamento attivo i risultati d'errore vengono dall'interruzione e non si registrano;
        // i tool conclusi con successo hanno agito davvero e il loro passo va scritto
        for (let i = 0; i < group.length; i++) {
          if (deps.signal?.aborted && !results[i].result.ok) continue;
          await record(group[i], results[i].result, results[i].durationMs);
        }
        if (deps.signal?.aborted) return finish({ type: "cancelled", state });
        continue;
      }

      state.queue.shift();
      const { result, durationMs } = await execute(prepared);
      if (deps.signal?.aborted && !result.ok) return finish({ type: "cancelled", state });
      await record(prepared, result, durationMs);
      if (deps.signal?.aborted) return finish({ type: "cancelled", state });
    }

    // 2. Limiti, controllati prima di ogni chiamata al modello
    const stopped = cancelled();
    if (stopped) return stopped;
    syncActive();
    if (state.rounds >= limits.maxRounds) {
      return finish({ type: "failed", error: `limite di ${limits.maxRounds} giri di strumenti raggiunto`, state });
    }
    if (state.tokens >= limits.maxTokens) {
      return finish({ type: "failed", error: "limite di token per turno superato", state });
    }
    if (state.activeMs >= limits.maxActiveMs) {
      return finish({ type: "failed", error: "tempo massimo del turno superato", state });
    }

    // 3. Chiamata al modello
    const t0 = now();
    let reply: ChatResult;
    try {
      reply = await deps.chat(state.messages, { remainingMs: limits.maxActiveMs - state.activeMs });
    } catch (err) {
      // Chiamata interrotta dall'annullamento: non è un errore del modello
      if (deps.signal?.aborted) return finish({ type: "cancelled", state });
      const message = errorMessage(err);
      await deps.onStep({ type: "model", ok: false, durationMs: now() - t0, error: message });
      return finish({ type: "failed", error: `errore nella chiamata al modello: ${message}`, state });
    }
    state.tokens += reply.promptTokens + reply.completionTokens;
    if (deps.signal?.aborted) return finish({ type: "cancelled", state });
    await deps.onStep({ type: "model", ok: true, durationMs: now() - t0 });

    if (reply.toolCalls.length === 0) {
      // Risposta interrotta dal limite di token di uscita: il testo è un frammento, non un esito
      if (reply.truncated) {
        return finish({ type: "failed", error: TRUNCATED_REPLY_ERROR, state });
      }
      const content = reply.content ?? "";
      state.messages.push({ role: "assistant", content });
      return finish({ type: "finished", content, state });
    }

    state.rounds += 1;
    state.messages.push({
      role: "assistant",
      content: reply.content,
      tool_calls: assistantToolCalls(reply.toolCalls),
    });

    // Limiti superati da questa stessa chiamata: le richieste non vengono eseguite (né accodate);
    // ognuna riceve un messaggio `tool` così la storia resta valida per i turni successivi
    syncActive();
    const exceeded =
      state.tokens >= limits.maxTokens
        ? "limite di token per turno superato"
        : state.activeMs >= limits.maxActiveMs
          ? "tempo massimo del turno superato"
          : null;
    if (exceeded) {
      for (const c of reply.toolCalls) state.messages.push(toolMessage(c.id, `non eseguito: ${exceeded}`));
      return finish({ type: "failed", error: exceeded, state });
    }

    state.queue = reply.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
  }
}

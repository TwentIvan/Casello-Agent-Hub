// Ciclo dell'agente: alterna chiamate al modello ed esecuzioni dei tool, si ferma
// per conferme e azioni di interfaccia, applica i limiti del turno.
// Modulo puro: niente DB né rete, tutte le dipendenze arrivano da `LoopDeps`.
// Lo stato (`LoopState`) è JSON puro: l'orchestratore lo salva nella run e lo riprende.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { assistantToolCalls, type ChatResult } from "./ai/chat-types";
import { maskSensitiveArgs } from "./tools/sensitive";
import type { CatalogTool, ToolResult } from "./tools/types";

export interface LoopLimits {
  maxRounds: number;
  maxActiveMs: number;
  maxTokens: number;
}

// Confronto con `>=`: il limite è raggiunto al valore indicato
// (es. con maxRounds 8 la nona chiamata al modello non parte; con 60 000 token esatti il turno si ferma)
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
  /** Tempo passato dentro runAgentLoop (le pause non contano) */
  activeMs: number;
}

export interface PendingAction {
  kind: "confirmation" | "ui";
  toolCallId: string;
  toolName: string;
  /** Argomenti veri: servono per eseguire il tool alla ripresa, mai esposti dall'API */
  args: Record<string, unknown>;
  /** Argomenti con le proprietà sensibili oscurate ("***"): la forma pubblica */
  publicArgs: Record<string, unknown>;
  /** Riassunto per l'utente, costruito dagli argomenti oscurati */
  summary: string;
}

export interface StepRecord {
  type: "model" | "tool";
  toolName?: string;
  args?: unknown;
  ok: boolean;
  httpStatus?: number;
  durationMs: number;
  error?: string;
}

export interface LoopDeps {
  /** `remainingMs`: tempo attivo ancora disponibile nel turno, per limitare la chiamata */
  chat(messages: ChatCompletionMessageParam[], opts: { remainingMs: number }): Promise<ChatResult>;
  tools: CatalogTool[];
  executeTool(tool: CatalogTool, args: Record<string, unknown>): Promise<ToolResult>;
  onStep(step: StepRecord): Promise<void>;
  limits?: Partial<LoopLimits>;
  now?: () => number;
  /** Annullamento: se scatta, il ciclo non inizia nuovi giri e si chiude come `cancelled` */
  signal?: AbortSignal;
}

export type LoopOutcome =
  | { type: "finished"; content: string; state: LoopState }
  | { type: "paused"; pending: PendingAction; state: LoopState }
  | { type: "failed"; error: string; state: LoopState }
  /** Annullato dall'esterno (`deps.signal`): niente altri passi, lo stato della run lo scrive chi ha annullato */
  | { type: "cancelled"; state: LoopState };

// Esito della preparazione di una chiamata: errore da restituire al modello o tool pronto
type PreparedCall =
  | { kind: "error"; call: ToolCall; args: unknown; message: string }
  | { kind: "ready"; call: ToolCall; tool: CatalogTool; args: Record<string, unknown> };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cloneState(state: LoopState): LoopState {
  return JSON.parse(JSON.stringify(state)) as LoopState;
}

function prepareCall(call: ToolCall, tools: CatalogTool[]): PreparedCall {
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
  return { kind: "ready", call, tool, args: parsed as Record<string, unknown> };
}

function needsPause(tool: CatalogTool): boolean {
  return tool.requiresConfirmation || tool.kind === "ui";
}

// Eseguibili in parallelo: sola lettura, senza conferma, HTTP
function isParallelSafe(p: PreparedCall): p is Extract<PreparedCall, { kind: "ready" }> {
  return p.kind === "ready" && p.tool.readOnly && !p.tool.requiresConfirmation && p.tool.kind === "http";
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

// Riceve gli argomenti già oscurati: i valori sensibili non finiscono nel riassunto
function buildSummary(tool: CatalogTool, args: Record<string, unknown>): string {
  const label = tool.description?.trim() || tool.name;
  const parts = Object.entries(args).map(([k, v]) => `${k}: ${formatValue(v)}`);
  return `${label}: ${parts.join(", ")}`;
}

function toolMessage(toolCallId: string, content: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: toolCallId, content };
}

/** L'azione in sospeso non corrisponde alla testa della coda (id errato o già risolta) */
export class PendingMismatchError extends Error {
  constructor(toolCallId: string, headId: string | undefined) {
    super(
      headId === undefined
        ? `l'azione in sospeso "${toolCallId}" non è in attesa: la coda è vuota`
        : `l'azione in sospeso "${toolCallId}" non corrisponde alla chiamata in attesa "${headId}"`,
    );
    this.name = "PendingMismatchError";
  }
}

/**
 * Aggiunge il risultato della chiamata in sospeso come messaggio `tool` e la toglie dalla coda.
 * La chiamata in pausa è sempre in testa alla coda: se l'id non coincide (azione errata o già
 * risolta) lancia `PendingMismatchError` invece di aggiungere un messaggio orfano o duplicato.
 * Non modifica lo stato ricevuto.
 */
export function resolvePending(state: LoopState, pending: PendingAction, result: ToolResult): LoopState {
  const headId = state.queue[0]?.id;
  if (headId !== pending.toolCallId) throw new PendingMismatchError(pending.toolCallId, headId);
  const next = cloneState(state);
  next.messages.push(toolMessage(pending.toolCallId, result.content));
  next.queue.shift();
  return next;
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
  const execute = async (p: Extract<PreparedCall, { kind: "ready" }>): Promise<{ result: ToolResult; durationMs: number }> => {
    const t0 = now();
    let result: ToolResult;
    try {
      result = await deps.executeTool(p.tool, p.args);
    } catch (err) {
      result = { ok: false, content: `Errore durante l'esecuzione di "${p.tool.name}": ${errorMessage(err)}` };
    }
    return { result, durationMs: now() - t0 };
  };

  const record = async (p: Extract<PreparedCall, { kind: "ready" }>, result: ToolResult, durationMs: number) => {
    state.messages.push(toolMessage(p.call.id, result.content));
    await deps.onStep({
      type: "tool",
      toolName: p.tool.name,
      args: p.args,
      ok: result.ok,
      httpStatus: result.status,
      durationMs,
      error: result.ok ? undefined : result.content,
    });
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
        await deps.onStep({
          type: "tool",
          toolName: prepared.call.name,
          args: prepared.args,
          ok: false,
          durationMs: 0,
          error: prepared.message,
        });
        continue;
      }

      if (needsPause(prepared.tool)) {
        // La chiamata resta in testa alla coda: la toglie resolvePending
        const publicArgs = maskSensitiveArgs(prepared.tool, prepared.args) as Record<string, unknown>;
        return finish({
          type: "paused",
          pending: {
            kind: prepared.tool.kind === "ui" ? "ui" : "confirmation",
            toolCallId: prepared.call.id,
            toolName: prepared.tool.name,
            args: prepared.args,
            publicArgs,
            summary: buildSummary(prepared.tool, publicArgs),
          },
          state,
        });
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

    // Limiti superati da questa stessa chiamata: le richieste non vengono eseguite (né messe in
    // pausa); ognuna riceve un messaggio `tool` così la storia resta valida per i turni successivi
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

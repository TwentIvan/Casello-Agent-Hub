// Ciclo dell'agente: alterna chiamate al modello ed esecuzioni dei tool, si ferma
// per conferme e azioni di interfaccia, applica i limiti del turno.
// Modulo puro: niente DB né rete, tutte le dipendenze arrivano da `LoopDeps`.
// Lo stato (`LoopState`) è JSON puro: l'orchestratore lo salva nella run e lo riprende.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ChatResult } from "./ai-gateway";
import type { CatalogTool, ToolResult } from "./tools/types";

export interface LoopLimits {
  maxRounds: number;
  maxActiveMs: number;
  maxTokens: number;
}

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
  args: Record<string, unknown>;
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
  chat(messages: ChatCompletionMessageParam[]): Promise<ChatResult>;
  tools: CatalogTool[];
  executeTool(tool: CatalogTool, args: Record<string, unknown>): Promise<ToolResult>;
  onStep(step: StepRecord): Promise<void>;
  limits?: Partial<LoopLimits>;
  now?: () => number;
}

export type LoopOutcome =
  | { type: "finished"; content: string; state: LoopState }
  | { type: "paused"; pending: PendingAction; state: LoopState }
  | { type: "failed"; error: string; state: LoopState };

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

function buildSummary(tool: CatalogTool, args: Record<string, unknown>): string {
  const label = tool.description?.trim() || tool.name;
  const parts = Object.entries(args).map(([k, v]) => `${k}: ${formatValue(v)}`);
  return `${label}: ${parts.join(", ")}`;
}

function toolMessage(toolCallId: string, content: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: toolCallId, content };
}

/**
 * Aggiunge il risultato della chiamata in sospeso come messaggio `tool` e la toglie dalla coda.
 * Non modifica lo stato ricevuto.
 */
export function resolvePending(state: LoopState, pending: PendingAction, result: ToolResult): LoopState {
  const next = cloneState(state);
  next.messages.push(toolMessage(pending.toolCallId, result.content));
  next.queue = next.queue.filter((c) => c.id !== pending.toolCallId);
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

  for (;;) {
    // 1. Svuota la coda delle chiamate rimaste
    while (state.queue.length > 0) {
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
        return finish({
          type: "paused",
          pending: {
            kind: prepared.tool.kind === "ui" ? "ui" : "confirmation",
            toolCallId: prepared.call.id,
            toolName: prepared.tool.name,
            args: prepared.args,
            summary: buildSummary(prepared.tool, prepared.args),
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
        for (let i = 0; i < group.length; i++) {
          await record(group[i], results[i].result, results[i].durationMs);
        }
        continue;
      }

      state.queue.shift();
      const { result, durationMs } = await execute(prepared);
      await record(prepared, result, durationMs);
    }

    // 2. Limiti, controllati prima di ogni chiamata al modello
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
      reply = await deps.chat(state.messages);
    } catch (err) {
      const message = errorMessage(err);
      await deps.onStep({ type: "model", ok: false, durationMs: now() - t0, error: message });
      return finish({ type: "failed", error: `errore nella chiamata al modello: ${message}`, state });
    }
    state.tokens += reply.promptTokens + reply.completionTokens;
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
      tool_calls: reply.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    });
    state.queue = reply.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
  }
}

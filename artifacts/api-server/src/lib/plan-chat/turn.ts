// Ciclo di un turno della chat del piano (puro: niente DB né rete). Il modello può usare gli strumenti
// per qualche giro; poi una chiamata finale senza strumenti produce la risposta all'utente.

import type { ChatCompletionFunctionTool, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { assistantToolCalls, type ChatToolCall } from "../ai/chat-types";
import { ProviderError } from "../ai/discovery";
import type { ModelChatResult } from "../ai/executor";
import { effectiveTokens } from "../architect/phase-loop";
import { CostTracker } from "../architect/run-analysis";
import { PLAN_TOOLS } from "./tools";

export interface PlanTurnLimits {
  maxRounds: number;
  maxTokens: number;
  maxActiveMs: number;
}

export const PLAN_TURN_LIMITS: PlanTurnLimits = { maxRounds: 6, maxTokens: 40_000, maxActiveMs: 120_000 };

/** Turni in cui Lucius legge il codice dell'app: più giri, più token e più tempo (spec «Lucius legge il codice»). */
export const CODE_TURN_LIMITS: PlanTurnLimits = { maxRounds: 12, maxTokens: 150_000, maxActiveMs: 240_000 };

export interface PlanTurnDeps {
  chat(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionFunctionTool[] | undefined,
    timeoutMs: number,
  ): Promise<ModelChatResult>;
  runTool(call: ChatToolCall): Promise<string>;
  now(): number;
  /** Interruzione richiesta dall'utente: si controlla prima di ogni chiamata al modello e di ogni strumento. */
  signal?: AbortSignal;
}

export type PlanTurnOutcome =
  | { ok: true; content: string; tokens: number; costUsd: string | null }
  | { ok: false; error: string; tokens: number; costUsd: string | null; stopped?: true };

/** Messaggio dell'assistente quando l'utente ferma il turno. */
export const STOPPED_TURN_MESSAGE = "Risposta interrotta.";

const OUT_OF_TOOLS = "Hai esaurito gli strumenti: rispondi ora all'utente.";

export async function runPlanTurn(
  messages: ChatCompletionMessageParam[],
  deps: PlanTurnDeps,
  limits: PlanTurnLimits = PLAN_TURN_LIMITS,
  tools: ChatCompletionFunctionTool[] = PLAN_TOOLS,
): Promise<PlanTurnOutcome> {
  const history = [...messages];
  const cost = new CostTracker();
  const startedAt = deps.now();
  // Registrati su messaggio e conversazione: prompt + completion
  let tokens = 0;
  // Budget del turno: come l'architetto, i token in cache pesano il 10%
  let budgetUsed = 0;

  const fail = (error: string): PlanTurnOutcome => ({ ok: false, error, tokens, costUsd: cost.value() });
  const stopped = (): PlanTurnOutcome => ({ ok: false, error: STOPPED_TURN_MESSAGE, tokens, costUsd: cost.value(), stopped: true });

  // Un giro: null = tempo scaduto prima di chiamare; altrimenti l'esito della chiamata o un errore già pronto
  const call = async (tools: ChatCompletionFunctionTool[] | undefined): Promise<ModelChatResult | PlanTurnOutcome> => {
    if (deps.signal?.aborted) return stopped();
    const left = limits.maxActiveMs - (deps.now() - startedAt);
    if (left <= 0) return fail("Tempo del turno scaduto.");
    let reply: ModelChatResult;
    try {
      reply = await deps.chat(history, tools, Math.max(1_000, left));
    } catch (err) {
      if (deps.signal?.aborted) return stopped();
      return fail(err instanceof ProviderError ? err.message : "Errore nella chiamata al modello.");
    }
    cost.add(reply);
    tokens += reply.promptTokens + reply.completionTokens;
    budgetUsed += effectiveTokens(reply);
    return reply;
  };
  const isOutcome = (r: ModelChatResult | PlanTurnOutcome): r is PlanTurnOutcome => "ok" in r;

  if (limits.maxTokens <= 0) return fail("Limite di token del turno raggiunto.");

  for (let round = 0; round < limits.maxRounds; round++) {
    const r = await call(tools);
    if (isOutcome(r)) return r;
    if (r.toolCalls.length === 0) return { ok: true, content: r.content ?? "", tokens, costUsd: cost.value() };
    // Budget superato: niente altri strumenti, si va alla risposta finale (non si eseguono le tool call)
    if (budgetUsed > limits.maxTokens) break;
    history.push({ role: "assistant", content: r.content, tool_calls: assistantToolCalls(r.toolCalls) });
    for (const c of r.toolCalls) {
      if (deps.signal?.aborted) return stopped();
      const content = await deps.runTool(c);
      history.push({ role: "tool", tool_call_id: c.id, content });
    }
  }

  history.push({ role: "user", content: OUT_OF_TOOLS });
  const last = await call(undefined);
  if (isOutcome(last)) return last;
  return { ok: true, content: last.content ?? "", tokens, costUsd: cost.value() };
}

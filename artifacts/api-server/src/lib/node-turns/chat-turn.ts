// Turno di una chat (personaggi, piano, squadra) sul suo esecutore (spec §5 «Chat», §6): un modello cloud usa il ciclo
// di sempre (`runPlanTurn`); un modello Claude Code delega il turno al nodo con gli stessi strumenti e lo stesso
// dispatcher. Se il nodo non è disponibile si ripiega sul modello cloud dell'account nodo, se c'è, è usabile e non ha
// raggiunto un tetto; altrimenti il messaggio fisso del nodo.

import type { ChatCompletionFunctionTool, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ChatToolCall } from "../ai/chat-types";
import { modelChat, resolveModel, type ResolvedModel } from "../ai/executor";
import { logger } from "../logger";
import { PLAN_TURN_LIMITS, runPlanTurn, type PlanTurnLimits, type PlanTurnOutcome } from "../plan-chat/turn";
import { describeStep } from "../turn-progress/describe";
import { beginTurnProgress, endTurnProgress, finishStep, startStep } from "../turn-progress/progress";
import { delegateTurn } from "./delegate";
import { NODE_TURN_MESSAGES } from "./messages";

/** Giri di Claude Code per un turno di chat: quelli di `runPlanTurn` più la risposta finale (spec §3). */
export const CHAT_NODE_MAX_TURNS = PLAN_TURN_LIMITS.maxRounds + 1;
export const CHAT_NODE_TIMEOUT_MS = 300_000;
/** In fondo alla risposta data dal modello di ripiego. */
export const FALLBACK_SUFFIX = "\n\n_(Claude Code non disponibile: risposta del modello di ripiego)_";

export interface ChatTurnInput {
  resolved: ResolvedModel;
  userId: number;
  consumer: "character" | "plan_chat" | "team_chat";
  /** Id della conversazione. */
  refId: number;
  /** Messaggio dell'assistente del turno. */
  messageId: number;
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionFunctionTool[];
  runTool(call: ChatToolCall): Promise<string>;
  /** Servizio chiamante, per i log del modello. */
  caller: string;
  /** Tetto di spesa per il modello di ripiego: il motivo del blocco, o null. */
  budgetCheck(aiModelId: number): Promise<string | null>;
  /** Limiti del turno (default `PLAN_TURN_LIMITS`); valgono anche sul nodo (giri + 1) e nel ripiego. */
  limits?: PlanTurnLimits;
}

function cloudTurn(resolved: ResolvedModel, input: ChatTurnInput): Promise<PlanTurnOutcome> {
  return runPlanTurn(
    input.messages,
    {
      chat: (msgs, tools, timeoutMs) => modelChat(resolved, { messages: msgs, tools, timeoutMs, caller: input.caller }),
      runTool: input.runTool,
      now: () => Date.now(),
    },
    input.limits ?? PLAN_TURN_LIMITS,
    input.tools,
  );
}

/** Modello di ripiego usabile (dell'utente, cloud, senza tetto raggiunto); null altrimenti. */
async function usableFallback(input: ChatTurnInput): Promise<ResolvedModel | null> {
  const id = input.resolved.fallbackAiModelId;
  if (id === null) return null;
  let fallback: ResolvedModel;
  try {
    fallback = await resolveModel(id, { userId: input.userId, mustOwn: true });
  } catch (err) {
    logger.warn({ fallbackAiModelId: id, errName: err instanceof Error ? err.name : "unknown" }, "Modello di ripiego non usabile");
    return null;
  }
  if (fallback.kind !== "openai_compatible") return null;
  if ((await input.budgetCheck(id)) !== null) return null;
  return fallback;
}

/** Esegue il turno e restituisce lo stesso esito di `runPlanTurn`. Errori inattesi del DB salgono al chiamante. */
export async function runChatTurn(original: ChatTurnInput): Promise<PlanTurnOutcome> {
  beginTurnProgress(original.consumer, original.refId);
  try {
    return await runTrackedTurn(original);
  } finally {
    endTurnProgress(original.consumer, original.refId);
  }
}

/** Come `runChatTurn`, con ogni chiamata di strumento registrata come passo visibile nella console. */
async function runTrackedTurn(original: ChatTurnInput): Promise<PlanTurnOutcome> {
  const input: ChatTurnInput = {
    ...original,
    async runTool(call) {
      const stepId = startStep(original.consumer, original.refId, describeStep(call.name, call.arguments));
      try {
        return await original.runTool(call);
      } finally {
        finishStep(original.consumer, original.refId, stepId);
      }
    },
  };
  if (input.resolved.kind !== "node") return cloudTurn(input.resolved, input);

  const outcome = await delegateTurn({
    resolved: input.resolved,
    userId: input.userId,
    consumer: input.consumer,
    refId: input.refId,
    messageId: input.messageId,
    messages: input.messages,
    tools: input.tools,
    dispatch: input.runTool,
    maxTurns: (input.limits ?? PLAN_TURN_LIMITS).maxRounds + 1,
    timeoutMs: CHAT_NODE_TIMEOUT_MS,
  });
  switch (outcome.kind) {
    case "done":
      return { ok: true, content: outcome.content, tokens: outcome.tokens, costUsd: outcome.costUsd };
    case "failed":
      return { ok: false, error: outcome.error, tokens: outcome.tokens, costUsd: outcome.costUsd };
    case "cancelled":
      return { ok: false, error: NODE_TURN_MESSAGES.stopped, tokens: 0, costUsd: null };
    case "fallback": {
      const fallback = await usableFallback(input);
      logger.info({ consumer: input.consumer, refId: input.refId, reason: outcome.reason, fallback: fallback !== null }, "Turno di chat senza Claude Code");
      if (!fallback) return { ok: false, error: outcome.message, tokens: 0, costUsd: null };
      const result = await cloudTurn(fallback, input);
      return result.ok ? { ...result, content: `${result.content}${FALLBACK_SUFFIX}` } : result;
    }
  }
}

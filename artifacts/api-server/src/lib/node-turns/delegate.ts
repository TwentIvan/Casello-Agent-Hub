// Delega di un turno a Claude Code sul nodo dell'account (spec §5 «delegateTurn», §6): se il nodo non è pronto si
// ripiega subito, senza accodare; altrimenti si accoda il turno, si registrano strumenti e dispatcher per /mcp/turn,
// si attende la chiusura e si toglie il registro in ogni caso. Messaggi verso l'utente solo da NODE_TURN_MESSAGES;
// nei log solo id e codici, mai prompt, contenuti o argomenti.

import { eq } from "drizzle-orm";
import type { ChatCompletionFunctionTool, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { db, nodesTable } from "@workspace/db";
import type { ChatToolCall } from "../ai/chat-types";
import type { ResolvedModel } from "../ai/executor";
import { markModelAvailable, markModelUnavailable } from "../ai/model-status";
import { nodeTurnReady } from "../ai/node-account";
import { logger } from "../logger";
import { NODE_TURN_MESSAGES, nodeTurnErrorMessage, type NodeTurnErrorCode } from "./messages";
import { toClaudePrompt } from "./prompt";
import { cancelTurn, enqueueTurn, waitTurn, type NodeTurnConsumer, type NodeTurnResult } from "./queue";
import { registerTurn, turnEntry, unregisterTurn } from "./registry";

/** Chiamate agli strumenti per giro di Claude Code: il turno ne ammette al massimo 4 × `maxTurns` (spec §4). */
const CALLS_PER_TURN = 4;
/** Risposta del dispatcher a una chiamata arrivata dopo la chiusura del turno. */
const TURN_CLOSED = JSON.stringify({ ok: false, error: "turno chiuso" });

export interface DelegateInput {
  resolved: ResolvedModel;
  userId: number;
  consumer: NodeTurnConsumer;
  refId: number;
  messageId?: number;
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionFunctionTool[];
  dispatch(call: ChatToolCall): Promise<string>;
  maxTurns: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type FallbackReason = NodeTurnErrorCode | "offline" | "expired" | "node_deleted";

export type DelegateOutcome =
  | {
      kind: "done";
      content: string;
      tokens: number;
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      costUsd: string | null;
    }
  /** `message`: il messaggio fisso da mostrare se il ripiego non c'è o non si può usare. */
  | { kind: "fallback"; reason: FallbackReason; message: string }
  | { kind: "failed"; error: string; tokens: number; costUsd: string | null }
  | { kind: "cancelled" };

/** Codici del nodo per cui si ripiega: Claude Code non ha lavorato, rifare il turno non duplica nulla (spec §6). */
const FALLBACK_CODES = new Set<NodeTurnErrorCode>(["usage_limit", "not_logged_in"]);

function fallback(reason: FallbackReason, nodeName: string): DelegateOutcome {
  const message =
    reason === "offline" || reason === "expired"
      ? NODE_TURN_MESSAGES.offline(nodeName)
      : reason === "node_deleted"
        ? NODE_TURN_MESSAGES.nodeDeleted
        : nodeTurnErrorMessage(reason);
  return { kind: "fallback", reason, message };
}

async function outcomeOf(result: NodeTurnResult, input: DelegateInput, nodeName: string): Promise<DelegateOutcome> {
  // Un report arrivato prima dell'annullamento vince: il contenuto resta
  if (result.status === "done") {
    await markModelAvailable(input.resolved.aiModelId);
    return {
      kind: "done",
      content: result.content ?? "",
      tokens: result.promptTokens + result.completionTokens,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cachedTokens: result.cachedTokens,
      costUsd: result.costUsd,
    };
  }
  if (result.status === "cancelled" || input.signal?.aborted) return { kind: "cancelled" };
  if (result.status === "expired") return fallback("expired", nodeName);
  const code = result.errorCode;
  if (code !== null && FALLBACK_CODES.has(code)) return fallback(code, nodeName);
  if (code === "model_unavailable") await markModelUnavailable(input.resolved.aiModelId);
  return {
    kind: "failed",
    error: nodeTurnErrorMessage(code),
    tokens: result.promptTokens + result.completionTokens,
    costUsd: result.costUsd,
  };
}

/**
 * Delega il turno al nodo dell'account del modello (`resolved.kind === "node"`). Nodo assente → ripiego `node_deleted`;
 * nodo non pronto (non attivo o senza presa negli ultimi 60 s) → ripiego `offline`, senza righe in `node_turns`.
 */
export async function delegateTurn(input: DelegateInput): Promise<DelegateOutcome> {
  const { resolved } = input;
  if (input.signal?.aborted) return { kind: "cancelled" };
  const [node] =
    resolved.nodeId === null
      ? []
      : await db
          .select({ name: nodesTable.name, status: nodesTable.status, lastTurnPollAt: nodesTable.lastTurnPollAt })
          .from(nodesTable)
          .where(eq(nodesTable.id, resolved.nodeId))
          .limit(1);
  if (!node || resolved.nodeId === null) return fallback("node_deleted", "");
  if (!nodeTurnReady(node)) return fallback("offline", node.name);

  const { systemPrompt, prompt } = toClaudePrompt(input.messages);
  const { turnId } = await enqueueTurn({
    nodeId: resolved.nodeId,
    userId: input.userId,
    aiModelId: resolved.aiModelId,
    consumer: input.consumer,
    refId: input.refId,
    messageId: input.messageId,
    pkg: { model: resolved.modelId, systemPrompt, prompt, maxTurns: input.maxTurns, timeoutMs: input.timeoutMs },
  });
  try {
    registerTurn(turnId, {
      tools: input.tools,
      // Una chiamata che arriva mentre il turno si chiude non esegue più lo strumento
      dispatch: (call) => (turnEntry(turnId) ? input.dispatch(call) : Promise.resolve(TURN_CLOSED)),
      maxCalls: CALLS_PER_TURN * input.maxTurns,
    });
    const result = await waitTurn(turnId, input.signal);
    const outcome = await outcomeOf(result, input, node.name);
    logger.info(
      { turnId, consumer: input.consumer, refId: input.refId, status: result.status, errorCode: result.errorCode, outcome: outcome.kind },
      "Turno delegato al nodo chiuso",
    );
    return outcome;
  } catch (err) {
    // Errore inatteso nell'attesa: il turno non deve restare aperto senza nessuno che ne legga l'esito
    await cancelTurn(turnId).catch(() => {});
    throw err;
  } finally {
    unregisterTurn(turnId);
  }
}

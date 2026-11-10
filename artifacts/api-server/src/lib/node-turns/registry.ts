// Registro in memoria dei turni delegati al nodo: strumenti offerti a Claude Code e dispatcher che li esegue
// (`/mcp/turn`). Lo scrive chi delega all'accodamento e lo toglie alla chiusura; un riavvio lo perde (i turni
// aperti falliscono `restart` all'avvio).

import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import type { ChatToolCall } from "../ai/chat-types";

export interface TurnEntry {
  tools: ChatCompletionFunctionTool[];
  dispatch(call: ChatToolCall): Promise<string>;
  /** Chiamate al massimo nel turno (4 × `maxTurns`). */
  maxCalls: number;
  /** Chiamate già fatte. */
  calls: number;
}

const entries = new Map<number, TurnEntry>();

export function registerTurn(
  turnId: number,
  entry: { tools: ChatCompletionFunctionTool[]; dispatch(call: ChatToolCall): Promise<string>; maxCalls: number },
): void {
  entries.set(turnId, { tools: entry.tools, dispatch: entry.dispatch, maxCalls: entry.maxCalls, calls: 0 });
}

export function turnEntry(turnId: number): TurnEntry | undefined {
  return entries.get(turnId);
}

export function unregisterTurn(turnId: number): void {
  entries.delete(turnId);
}

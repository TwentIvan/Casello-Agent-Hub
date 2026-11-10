import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedModel } from "../ai/executor";
import { CODE_TURN_LIMITS, PLAN_TURN_LIMITS } from "../plan-chat/turn";

const modelChat = vi.fn();
const delegateTurn = vi.fn();
vi.mock("../ai/executor", () => ({ modelChat: (...a: unknown[]) => modelChat(...a), resolveModel: vi.fn() }));
vi.mock("./delegate", () => ({ delegateTurn: (...a: unknown[]) => delegateTurn(...a) }));

import { CHAT_NODE_MAX_TURNS, runChatTurn, type ChatTurnInput } from "./chat-turn";

const TOOL = { type: "function" as const, function: { name: "leggi_prova", description: "Legge", parameters: { type: "object", properties: {} } } };

function reply(toolCall: boolean) {
  return {
    content: toolCall ? null : "fatto",
    toolCalls: toolCall ? [{ id: `c${Math.random()}`, name: "leggi_prova", arguments: "{}" }] : [],
    promptTokens: 10,
    completionTokens: 5,
    cachedPromptTokens: 0,
    costUsd: null,
  };
}

function input(kind: "node" | "openai_compatible", over: Partial<ChatTurnInput> = {}): ChatTurnInput {
  return {
    resolved: { kind, fallbackAiModelId: null } as unknown as ResolvedModel,
    userId: 1,
    consumer: "character",
    refId: 1,
    messageId: 1,
    messages: [{ role: "user", content: "ciao" }],
    tools: [TOOL],
    runTool: async () => "{}",
    caller: "test",
    budgetCheck: async () => null,
    ...over,
  };
}

beforeEach(() => {
  modelChat.mockReset();
  delegateTurn.mockReset();
});

describe("runChatTurn: limiti", () => {
  it("con i limiti di default 6 giri di strumenti non bastano a 11 chiamate", async () => {
    for (let i = 0; i < 11; i++) modelChat.mockResolvedValueOnce(reply(true));
    modelChat.mockResolvedValue(reply(false));
    const out = await runChatTurn(input("openai_compatible"));
    // Dopo 6 giri la chiamata finale è senza strumenti: le chiamate sono 7, non 12
    expect(modelChat.mock.calls.length).toBe(PLAN_TURN_LIMITS.maxRounds + 1);
    expect(out.ok).toBe(true);
  });

  it("con CODE_TURN_LIMITS ammette 11 giri di strumenti e poi risponde", async () => {
    for (let i = 0; i < 11; i++) modelChat.mockResolvedValueOnce(reply(true));
    modelChat.mockResolvedValueOnce(reply(false));
    const runTool = vi.fn(async () => "{}");
    const out = await runChatTurn(input("openai_compatible", { limits: CODE_TURN_LIMITS, runTool }));
    expect(out).toMatchObject({ ok: true, content: "fatto" });
    expect(runTool).toHaveBeenCalledTimes(11);
  });

  it("sul nodo maxTurns = giri + 1", async () => {
    delegateTurn.mockResolvedValue({ kind: "done", content: "ok", tokens: 1, costUsd: null });
    await runChatTurn(input("node", { limits: CODE_TURN_LIMITS }));
    expect(delegateTurn.mock.calls[0]![0]).toMatchObject({ maxTurns: 13, timeoutMs: 300_000 });
    await runChatTurn(input("node"));
    expect(delegateTurn.mock.calls[1]![0]).toMatchObject({ maxTurns: CHAT_NODE_MAX_TURNS });
  });
});

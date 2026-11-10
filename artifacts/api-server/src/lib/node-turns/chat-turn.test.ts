import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedModel } from "../ai/executor";
import { CODE_TURN_LIMITS, PLAN_TURN_LIMITS } from "../plan-chat/turn";

const modelChat = vi.fn();
const delegateTurn = vi.fn();
vi.mock("../ai/executor", () => ({ modelChat: (...a: unknown[]) => modelChat(...a), resolveModel: vi.fn() }));
vi.mock("./delegate", () => ({ delegateTurn: (...a: unknown[]) => delegateTurn(...a) }));

import { readTurnProgress } from "../turn-progress/progress";
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

describe("runChatTurn: avanzamento", () => {
  it("registra il passo durante lo strumento", async () => {
    modelChat.mockResolvedValueOnce(reply(true));
    modelChat.mockResolvedValueOnce(reply(false));
    let seen: ReturnType<typeof readTurnProgress> = null;
    await runChatTurn(input("openai_compatible", { runTool: async () => { seen = readTurnProgress("character", 1); return "{}"; } }));
    expect(seen!.steps).toEqual([{ text: "Usa uno strumento", status: "running" }]);
    expect(readTurnProgress("character", 1)).toBeNull();
  });

  it("passo done dopo lo strumento", async () => {
    modelChat.mockResolvedValueOnce(reply(true));
    modelChat.mockResolvedValueOnce(reply(true));
    modelChat.mockResolvedValueOnce(reply(false));
    const seen: Array<ReturnType<typeof readTurnProgress>> = [];
    await runChatTurn(input("openai_compatible", { runTool: async () => { seen.push(readTurnProgress("character", 1)); return "{}"; } }));
    expect(seen[1]!.steps[0]!.status).toBe("done");
  });

  it("registro vuoto se il modello fallisce", async () => {
    modelChat.mockRejectedValue(new Error("boom"));
    await runChatTurn(input("openai_compatible")).catch(() => undefined);
    expect(readTurnProgress("character", 1)).toBeNull();
  });

  it("registro vuoto se runTool lancia", async () => {
    modelChat.mockResolvedValueOnce(reply(true));
    await expect(runChatTurn(input("openai_compatible", { runTool: async () => { throw new Error("ko"); } }))).rejects.toThrow();
    expect(readTurnProgress("character", 1)).toBeNull();
  });

  it("sul nodo registra il passo del dispatcher", async () => {
    let seen: ReturnType<typeof readTurnProgress> = null;
    delegateTurn.mockImplementation(async (a: { dispatch(c: unknown): Promise<string> }) => {
      await a.dispatch({ id: "x", name: "leggi_file", arguments: '{"percorso":"a.ts"}' });
      return { kind: "done", content: "ok", tokens: 1, costUsd: null };
    });
    await runChatTurn(input("node", { runTool: async () => { seen = readTurnProgress("character", 1); return "{}"; } }));
    expect(seen!.steps[0]!.text).toBe("Legge a.ts");
    expect(readTurnProgress("character", 1)).toBeNull();
  });
});

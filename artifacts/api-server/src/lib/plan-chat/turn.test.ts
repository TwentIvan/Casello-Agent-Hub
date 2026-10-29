import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ProviderError } from "../ai/discovery";
import type { ModelChatResult } from "../ai/executor";
import { runPlanTurn, type PlanTurnDeps } from "./turn";

const reply = (over: Partial<ModelChatResult>): ModelChatResult => ({
  content: null,
  toolCalls: [],
  promptTokens: 10,
  completionTokens: 5,
  cachedPromptTokens: 0,
  costUsd: 0.001,
  ...over,
});
const toolReply = (over: Partial<ModelChatResult> = {}) =>
  reply({ toolCalls: [{ id: "t1", name: "read_app", arguments: "{}" }], ...over });

function makeDeps(replies: Array<ModelChatResult | Error>, extra: Partial<PlanTurnDeps> = {}) {
  const sent: Array<{ messages: ChatCompletionMessageParam[]; tools: unknown; timeoutMs: number }> = [];
  const queue = [...replies];
  const deps: PlanTurnDeps = {
    chat: async (messages, tools, timeoutMs) => {
      sent.push({ messages: structuredClone(messages), tools, timeoutMs });
      const next = queue.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
    runTool: async () => "esito",
    now: () => 0,
    ...extra,
  };
  return { deps, sent };
}

const start: ChatCompletionMessageParam[] = [{ role: "user", content: "ciao" }];

describe("runPlanTurn", () => {
  it("risposta senza strumenti chiude il turno", async () => {
    const { deps } = makeDeps([reply({ content: "Ciao" })]);
    expect(await runPlanTurn(start, deps)).toEqual({ ok: true, content: "Ciao", tokens: 15, costUsd: "0.001" });
  });

  it("esegue le tool call e passa l'esito al modello", async () => {
    const { deps, sent } = makeDeps([toolReply(), reply({ content: "fatto" })]);
    const out = await runPlanTurn(start, deps);
    expect(out).toMatchObject({ ok: true, content: "fatto" });
    const second = sent[1].messages;
    expect(second.some((m) => m.role === "assistant" && "tool_calls" in m)).toBe(true);
    expect(second.at(-1)).toEqual({ role: "tool", tool_call_id: "t1", content: "esito" });
  });

  it("dopo 6 giri la chiamata finale è senza strumenti", async () => {
    const replies = [...Array(6)].map(() => toolReply());
    const { deps, sent } = makeDeps([...replies, reply({ content: "ecco" })]);
    const out = await runPlanTurn(start, deps);
    expect(out).toMatchObject({ ok: true, content: "ecco" });
    expect(sent).toHaveLength(7);
    expect(sent[5].tools).toBeDefined();
    expect(sent[6].tools).toBeUndefined();
    expect(sent[6].messages.at(-1)).toEqual({ role: "system", content: "Hai esaurito gli strumenti: rispondi ora all'utente." });
  });

  it("oltre 40 000 token il turno fallisce", async () => {
    const { deps } = makeDeps([toolReply({ promptTokens: 41_000 })]);
    expect(await runPlanTurn(start, deps)).toMatchObject({ ok: false, error: "Limite di token del turno raggiunto." });
  });

  it("tempo scaduto", async () => {
    let t = 0;
    const { deps } = makeDeps([toolReply()], { now: () => (t += 130_000) });
    expect(await runPlanTurn(start, deps)).toMatchObject({ ok: false, error: "Tempo del turno scaduto." });
  });

  it("il timeout di ogni chiamata è il tempo rimasto, minimo 1 s", async () => {
    let t = 0;
    const times = [0, 0, 119_900, 119_900];
    const { deps, sent } = makeDeps([toolReply(), reply({ content: "x" })], { now: () => times[t++] ?? 119_900 });
    await runPlanTurn(start, deps);
    expect(sent[0].timeoutMs).toBe(120_000);
    expect(sent[1].timeoutMs).toBe(1_000);
  });

  it("errore del provider", async () => {
    const err = new ProviderError("unreachable");
    const { deps } = makeDeps([err]);
    const out = await runPlanTurn(start, deps);
    expect(out).toMatchObject({ ok: false, error: err.message });
    const { deps: d2 } = makeDeps([new Error("boom")]);
    expect(await runPlanTurn(start, d2)).toMatchObject({ ok: false, error: "Errore nella chiamata al modello." });
  });
});

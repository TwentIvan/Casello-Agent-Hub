import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ProviderError } from "../ai/discovery";
import type { ModelChatResult } from "../ai/executor";
import { APIUserAbortError } from "openai";
import { STOPPED_TURN_MESSAGE, runPlanTurn, type PlanTurnDeps } from "./turn";

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
    expect(sent[6].messages.at(-1)).toEqual({ role: "user", content: "Hai esaurito gli strumenti: rispondi ora all'utente." });
  });

  it("risposta finale oltre il budget, senza strumenti: ok con il contenuto", async () => {
    const { deps } = makeDeps([reply({ content: "Risposta", promptTokens: 41_000 })]);
    expect(await runPlanTurn(start, deps)).toMatchObject({ ok: true, content: "Risposta", tokens: 41_005 });
  });

  it("risposta oltre il budget con tool call: strumento non eseguito, chiamata finale senza strumenti", async () => {
    const runTool = vi.fn(async () => "esito");
    const { deps, sent } = makeDeps([toolReply({ promptTokens: 41_000 }), reply({ content: "Sintesi" })], { runTool });
    const out = await runPlanTurn(start, deps);
    expect(out).toMatchObject({ ok: true, content: "Sintesi" });
    expect(runTool).not.toHaveBeenCalled();
    expect(sent).toHaveLength(2);
    expect(sent[1].tools).toBeUndefined();
    expect(sent[1].messages.at(-1)).toEqual({ role: "user", content: "Hai esaurito gli strumenti: rispondi ora all'utente." });
    expect(sent[1].messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("i token in cache pesano il 10% nel budget", async () => {
    // 45 000 di prompt, di cui 40 000 in cache: 5 000 + 4 000 + 5 = 9 005 pesati, sotto il tetto
    const cached = toolReply({ promptTokens: 45_000, cachedPromptTokens: 40_000 });
    const runTool = vi.fn(async () => "esito");
    const { deps, sent } = makeDeps([cached, reply({ content: "ok" })], { runTool });
    const out = await runPlanTurn(start, deps);
    expect(out).toMatchObject({ ok: true, content: "ok", tokens: 45_005 + 15 });
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(sent[1].tools).toBeDefined();
  });

  it("budget già esaurito prima della prima chiamata: limite di token", async () => {
    const { deps, sent } = makeDeps([]);
    const out = await runPlanTurn(start, deps, { maxRounds: 6, maxTokens: 0, maxActiveMs: 120_000 });
    expect(out).toMatchObject({ ok: false, error: "Limite di token del turno raggiunto." });
    expect(sent).toHaveLength(0);
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

  it("offre al modello esattamente gli strumenti passati", async () => {
    const { deps, sent } = makeDeps([reply({ content: "Ciao" })]);
    const custom = [{ type: "function" as const, function: { name: "solo_questo", parameters: { type: "object" } } }];
    await runPlanTurn(start, deps, undefined, custom);
    expect(sent[0]!.tools).toEqual(custom);
  });
});

describe("runPlanTurn: interruzione", () => {
  it("segnale già annullato: nessuna chiamata al modello", async () => {
    const ac = new AbortController();
    ac.abort();
    const { deps, sent } = makeDeps([reply({ content: "x" })], { signal: ac.signal });
    expect(await runPlanTurn(start, deps)).toMatchObject({ ok: false, stopped: true, error: STOPPED_TURN_MESSAGE, tokens: 0 });
    expect(sent).toHaveLength(0);
  });

  it("annullato tra due strumenti: il secondo non parte e i token del primo giro restano", async () => {
    const ac = new AbortController();
    const runTool = vi.fn(async () => {
      ac.abort();
      return "esito";
    });
    const two = toolReply({ toolCalls: [{ id: "a", name: "read_app", arguments: "{}" }, { id: "b", name: "read_app", arguments: "{}" }] });
    const { deps } = makeDeps([two], { signal: ac.signal, runTool });
    const out = await runPlanTurn(start, deps);
    expect(out).toMatchObject({ ok: false, stopped: true, tokens: 15 });
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it("annullato durante la chiamata: stopped, non il messaggio del provider", async () => {
    const ac = new AbortController();
    const { deps } = makeDeps([], {
      signal: ac.signal,
      chat: async () => {
        ac.abort();
        throw new APIUserAbortError();
      },
    });
    expect(await runPlanTurn(start, deps)).toMatchObject({ ok: false, stopped: true, error: STOPPED_TURN_MESSAGE });
  });
});

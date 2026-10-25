import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ChatResult } from "./ai-gateway";
import {
  DEFAULT_LIMITS,
  PendingMismatchError,
  resolvePending,
  runAgentLoop,
  type LoopDeps,
  type LoopState,
  type StepRecord,
} from "./agent-loop";
import type { CatalogTool, ToolResult } from "./tools/types";

function makeTool(overrides: Partial<CatalogTool> & { name: string }): CatalogTool {
  const now = new Date(0);
  return {
    id: 1,
    appId: 1,
    description: `Descrizione di ${overrides.name}`,
    kind: "http",
    identity: "user",
    requiresConfirmation: false,
    readOnly: false,
    status: "active",
    paramsSchema: { type: "object", properties: {} },
    definition: { method: "GET", path: "/x", paramLocations: {} },
    evidence: null,
    needsVerification: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as CatalogTool;
}

const leggiRosa = makeTool({ name: "leggi_rosa", description: "Legge la rosa", readOnly: true });
const leggiCalendario = makeTool({ name: "leggi_calendario", readOnly: true });
const scambia = makeTool({
  name: "proponi_scambio",
  description: "Propone uno scambio",
  requiresConfirmation: true,
  definition: { method: "POST", path: "/scambi", paramLocations: {} },
});
const apriPagina = makeTool({ name: "apri_pagina", kind: "ui", definition: { action: "navigate" } });
const tools = [leggiRosa, leggiCalendario, scambia, apriPagina];

function reply(content: string, tokens = 10): ChatResult {
  return { content, toolCalls: [], promptTokens: tokens, completionTokens: 0 };
}

function callTools(calls: { id: string; name: string; args: string }[], promptTokens = 10): ChatResult {
  return {
    content: null,
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
    promptTokens,
    completionTokens: 5,
  };
}

function initialState(): LoopState {
  return {
    messages: [{ role: "user", content: "ciao" }],
    queue: [],
    rounds: 0,
    tokens: 0,
    activeMs: 0,
  };
}

// Dipendenze finte: il modello risponde secondo la sequenza data
function makeDeps(responses: ChatResult[], extra: Partial<LoopDeps> = {}) {
  const steps: StepRecord[] = [];
  const seen: ChatCompletionMessageParam[][] = [];
  const chat = vi.fn(async (messages: ChatCompletionMessageParam[]) => {
    seen.push(JSON.parse(JSON.stringify(messages)));
    const next = responses.shift();
    if (!next) throw new Error("nessuna risposta prevista");
    return next;
  });
  const executeTool = vi.fn(
    async (tool: CatalogTool, args: Record<string, unknown>): Promise<ToolResult> => ({
      ok: true,
      status: 200,
      content: `${tool.name}:${JSON.stringify(args)}`,
    }),
  );
  const deps: LoopDeps = {
    chat,
    tools,
    executeTool,
    onStep: async (s) => {
      steps.push(s);
    },
    ...extra,
  };
  return { deps, steps, chat, executeTool, seen };
}

// Ogni tool_call di un messaggio assistente ha esattamente un messaggio tool
function expectValidHistory(messages: ChatCompletionMessageParam[]): void {
  const callIds: string[] = [];
  const answered: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        expect(tc.type).toBe("function");
        callIds.push(tc.id);
      }
    }
    if (m.role === "tool") answered.push(m.tool_call_id);
  }
  expect([...answered].sort()).toEqual([...callIds].sort());
}

describe("runAgentLoop", () => {
  it("risposta diretta", async () => {
    const { deps, steps } = makeDeps([reply("Ecco la risposta")]);
    const out = await runAgentLoop(initialState(), deps);
    expect(out.type).toBe("finished");
    if (out.type !== "finished") return;
    expect(out.content).toBe("Ecco la risposta");
    expect(steps.map((s) => s.type)).toEqual(["model"]);
    expect(out.state.rounds).toBe(0);
    expect(out.state.tokens).toBe(10);
  });

  it("contenuto finale nullo → stringa vuota", async () => {
    const { deps } = makeDeps([{ content: null, toolCalls: [], promptTokens: 1, completionTokens: 1 }]);
    const out = await runAgentLoop(initialState(), deps);
    expect(out).toMatchObject({ type: "finished", content: "" });
  });

  it("un giro di tool", async () => {
    const { deps, steps, executeTool, seen } = makeDeps([
      callTools([{ id: "c1", name: "leggi_rosa", args: '{"squadra":"Roma"}' }]),
      reply("La rosa è pronta"),
    ]);
    const out = await runAgentLoop(initialState(), deps);
    expect(out).toMatchObject({ type: "finished", content: "La rosa è pronta" });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(leggiRosa, { squadra: "Roma" });
    expect(steps.map((s) => s.type)).toEqual(["model", "tool", "model"]);
    expect(steps[1]).toMatchObject({
      type: "tool",
      toolName: "leggi_rosa",
      args: { squadra: "Roma" },
      ok: true,
      httpStatus: 200,
    });
    // la seconda chiamata al modello vede la richiesta e il risultato
    const history = seen[1];
    expect(history[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "leggi_rosa", arguments: '{"squadra":"Roma"}' } },
      ],
    });
    expect(history[2]).toEqual({ role: "tool", tool_call_id: "c1", content: 'leggi_rosa:{"squadra":"Roma"}' });
    expect(out.state.rounds).toBe(1);
    expect(out.state.tokens).toBe(15 + 10);
    expectValidHistory(out.state.messages);
  });

  it("errore del tool registrato come passo non riuscito e restituito al modello", async () => {
    const { deps, steps, seen } = makeDeps(
      [callTools([{ id: "c1", name: "leggi_rosa", args: "{}" }]), reply("ok")],
      { executeTool: async () => ({ ok: false, status: 500, content: "errore HTTP 500" }) },
    );
    const out = await runAgentLoop(initialState(), deps);
    expect(out.type).toBe("finished");
    expect(steps[1]).toMatchObject({ ok: false, httpStatus: 500, error: "errore HTTP 500" });
    expect(seen[1][2]).toEqual({ role: "tool", tool_call_id: "c1", content: "errore HTTP 500" });
  });

  it("tool sconosciuto", async () => {
    const { deps, steps, executeTool, seen } = makeDeps([
      callTools([{ id: "c1", name: "cancella_tutto", args: "{}" }]),
      reply("Non posso farlo"),
    ]);
    const out = await runAgentLoop(initialState(), deps);
    expect(out).toMatchObject({ type: "finished", content: "Non posso farlo" });
    expect(executeTool).not.toHaveBeenCalled();
    const toolMsg = seen[1][2];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg).toMatchObject({ tool_call_id: "c1" });
    expect(String(toolMsg.content)).toContain("cancella_tutto");
    expect(steps[1]).toMatchObject({ type: "tool", toolName: "cancella_tutto", ok: false });
    expectValidHistory(out.state.messages);
  });

  it("argomenti JSON non validi", async () => {
    const { deps, steps, executeTool, seen } = makeDeps([
      callTools([{ id: "c1", name: "leggi_rosa", args: "{squadra: Roma" }]),
      reply("Riprovo dopo"),
    ]);
    const out = await runAgentLoop(initialState(), deps);
    expect(out).toMatchObject({ type: "finished", content: "Riprovo dopo" });
    expect(executeTool).not.toHaveBeenCalled();
    expect(seen[1][2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(String(seen[1][2].content)).toMatch(/JSON/);
    expect(steps[1]).toMatchObject({ type: "tool", args: "{squadra: Roma", ok: false });
    expectValidHistory(out.state.messages);
  });

  it("argomenti JSON che non sono un oggetto", async () => {
    const { deps, executeTool, seen } = makeDeps([
      callTools([{ id: "c1", name: "leggi_rosa", args: "[1,2]" }]),
      reply("ok"),
    ]);
    const out = await runAgentLoop(initialState(), deps);
    expect(out.type).toBe("finished");
    expect(executeTool).not.toHaveBeenCalled();
    expect(String(seen[1][2].content)).toMatch(/oggetto/);
  });

  it("argomenti vuoti valgono come oggetto vuoto", async () => {
    const { deps, executeTool } = makeDeps([callTools([{ id: "c1", name: "leggi_rosa", args: "" }]), reply("ok")]);
    await runAgentLoop(initialState(), deps);
    expect(executeTool).toHaveBeenCalledWith(leggiRosa, {});
  });

  it("conferma", async () => {
    const { deps, steps, executeTool } = makeDeps([
      callTools([{ id: "c1", name: "proponi_scambio", args: '{"da":"Totti","a":"Del Piero"}' }]),
      reply("Scambio proposto"),
    ]);
    const out = await runAgentLoop(initialState(), deps);
    expect(out.type).toBe("paused");
    if (out.type !== "paused") return;
    expect(out.pending).toEqual({
      kind: "confirmation",
      toolCallId: "c1",
      toolName: "proponi_scambio",
      args: { da: "Totti", a: "Del Piero" },
      publicArgs: { da: "Totti", a: "Del Piero" },
      summary: "Propone uno scambio: da: Totti, a: Del Piero",
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(steps.map((s) => s.type)).toEqual(["model"]);
    expect(out.state.queue.map((c) => c.id)).toEqual(["c1"]);

    // lo stato attraversa il DB come JSON
    const stored = JSON.parse(JSON.stringify(out.state)) as LoopState;
    const resumed = resolvePending(stored, out.pending, { ok: true, status: 201, content: "scambio creato" });
    expect(resumed.queue).toEqual([]);
    expect(resumed.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "scambio creato" });

    const final = await runAgentLoop(resumed, deps);
    expect(final).toMatchObject({ type: "finished", content: "Scambio proposto" });
    expect(executeTool).not.toHaveBeenCalled();
    expectValidHistory(final.state.messages);
  });

  it("resolvePending non modifica lo stato ricevuto", async () => {
    const { deps } = makeDeps([callTools([{ id: "c1", name: "proponi_scambio", args: "{}" }])]);
    const out = await runAgentLoop(initialState(), deps);
    if (out.type !== "paused") throw new Error("atteso paused");
    const before = JSON.stringify(out.state);
    resolvePending(out.state, out.pending, { ok: false, content: "rifiutato dall'utente" });
    expect(JSON.stringify(out.state)).toBe(before);
  });

  it("resolvePending con id diverso dalla testa della coda → errore", async () => {
    const { deps } = makeDeps([
      callTools([
        { id: "c1", name: "proponi_scambio", args: "{}" },
        { id: "c2", name: "leggi_rosa", args: "{}" },
      ]),
    ]);
    const out = await runAgentLoop(initialState(), deps);
    if (out.type !== "paused") throw new Error("atteso paused");
    expect(() => resolvePending(out.state, { ...out.pending, toolCallId: "c2" }, { ok: true, content: "x" })).toThrow(
      PendingMismatchError,
    );
    expect(() => resolvePending(out.state, { ...out.pending, toolCallId: "zz" }, { ok: true, content: "x" })).toThrow(
      PendingMismatchError,
    );
  });

  it("resolvePending due volte sulla stessa azione → errore, nessun messaggio duplicato", async () => {
    const { deps } = makeDeps([callTools([{ id: "c1", name: "proponi_scambio", args: "{}" }])]);
    const out = await runAgentLoop(initialState(), deps);
    if (out.type !== "paused") throw new Error("atteso paused");
    const once = resolvePending(out.state, out.pending, { ok: true, content: "ok" });
    expect(() => resolvePending(once, out.pending, { ok: true, content: "ok" })).toThrow(PendingMismatchError);
    expect(once.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("id duplicati dal modello: resolvePending toglie solo la testa", async () => {
    const { deps } = makeDeps([
      callTools([
        { id: "dup", name: "proponi_scambio", args: "{}" },
        { id: "dup", name: "leggi_rosa", args: "{}" },
      ]),
    ]);
    const out = await runAgentLoop(initialState(), deps);
    if (out.type !== "paused") throw new Error("atteso paused");
    const resumed = resolvePending(out.state, out.pending, { ok: true, content: "ok" });
    expect(resumed.queue).toEqual([{ id: "dup", name: "leggi_rosa", arguments: "{}" }]);
  });

  it("azione di interfaccia → pausa ui", async () => {
    const { deps, executeTool } = makeDeps([callTools([{ id: "c1", name: "apri_pagina", args: '{"pagina":"rosa"}' }])]);
    const out = await runAgentLoop(initialState(), deps);
    expect(out).toMatchObject({
      type: "paused",
      pending: { kind: "ui", toolCallId: "c1", toolName: "apri_pagina", args: { pagina: "rosa" } },
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("riassunto con valori non stringa e descrizione mancante", async () => {
    const senzaDescrizione = makeTool({ name: "muovi", description: null, requiresConfirmation: true });
    const { deps } = makeDeps([callTools([{ id: "c1", name: "muovi", args: '{"n":3,"opz":{"x":true}}' }])], {
      tools: [senzaDescrizione],
    });
    const out = await runAgentLoop(initialState(), deps);
    if (out.type !== "paused") throw new Error("atteso paused");
    expect(out.pending.summary).toBe('muovi: n: 3, opz: {"x":true}');
  });

  it("coda dopo la pausa", async () => {
    const order: string[] = [];
    const { deps, chat, steps } = makeDeps(
      [
        callTools([
          { id: "c1", name: "proponi_scambio", args: "{}" },
          { id: "c2", name: "leggi_rosa", args: '{"squadra":"Lazio"}' },
        ]),
        reply("Fatto"),
      ],
      {
        executeTool: async (tool) => {
          order.push(`tool:${tool.name}`);
          return { ok: true, status: 200, content: "rosa" };
        },
      },
    );
    const out = await runAgentLoop(initialState(), deps);
    if (out.type !== "paused") throw new Error("atteso paused");
    expect(out.state.queue.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(order).toEqual([]);

    const resumed = resolvePending(JSON.parse(JSON.stringify(out.state)), out.pending, {
      ok: true,
      content: "ok",
    });
    expect(resumed.queue.map((c) => c.id)).toEqual(["c2"]);
    chat.mockImplementationOnce(async () => {
      order.push("model");
      return reply("Fatto");
    });
    const final = await runAgentLoop(resumed, deps);
    expect(final).toMatchObject({ type: "finished", content: "Fatto" });
    expect(order).toEqual(["tool:leggi_rosa", "model"]);
    expect(steps.map((s) => s.type)).toEqual(["model", "tool", "model"]);
    // ordine dei messaggi tool: c1 (ripresa) poi c2
    const toolIds = final.state.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(toolIds).toEqual(["c1", "c2"]);
    expectValidHistory(final.state.messages);
  });

  it("parallelo readOnly", async () => {
    const started: string[] = [];
    const resolvers: Record<string, (r: ToolResult) => void> = {};
    const { deps, steps, seen } = makeDeps(
      [
        callTools([
          { id: "c1", name: "leggi_rosa", args: "{}" },
          { id: "c2", name: "leggi_calendario", args: "{}" },
        ]),
        reply("Fine"),
      ],
      {
        executeTool: (tool) =>
          new Promise<ToolResult>((resolve) => {
            started.push(tool.name);
            resolvers[tool.name] = resolve;
          }),
      },
    );
    const promise = runAgentLoop(initialState(), deps);
    // entrambe partono prima che una qualsiasi termini
    await vi.waitFor(() => expect(started).toEqual(["leggi_rosa", "leggi_calendario"]));
    // termina prima la seconda: l'ordine dei messaggi resta quello originale
    resolvers.leggi_calendario({ ok: true, status: 200, content: "calendario" });
    await Promise.resolve();
    resolvers.leggi_rosa({ ok: true, status: 200, content: "rosa" });
    const out = await promise;
    expect(out.type).toBe("finished");
    expect(seen[1].slice(2)).toEqual([
      { role: "tool", tool_call_id: "c1", content: "rosa" },
      { role: "tool", tool_call_id: "c2", content: "calendario" },
    ]);
    expect(steps.map((s) => s.toolName ?? s.type)).toEqual(["model", "leggi_rosa", "leggi_calendario", "model"]);
  });

  it("le chiamate non readOnly sono eseguite in sequenza", async () => {
    const scrivi = makeTool({ name: "scrivi", readOnly: false });
    const started: string[] = [];
    const resolvers: ((r: ToolResult) => void)[] = [];
    const { deps } = makeDeps(
      [
        callTools([
          { id: "c1", name: "scrivi", args: '{"n":1}' },
          { id: "c2", name: "scrivi", args: '{"n":2}' },
        ]),
        reply("ok"),
      ],
      {
        tools: [scrivi],
        executeTool: (_tool, args) =>
          new Promise<ToolResult>((resolve) => {
            started.push(String(args.n));
            resolvers.push(resolve);
          }),
      },
    );
    const promise = runAgentLoop(initialState(), deps);
    await vi.waitFor(() => expect(started).toEqual(["1"]));
    // la seconda non parte finché la prima non termina
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(started).toEqual(["1"]);
    resolvers[0]({ ok: true, content: "ok" });
    await vi.waitFor(() => expect(started).toEqual(["1", "2"]));
    resolvers[1]({ ok: true, content: "ok" });
    expect((await promise).type).toBe("finished");
  });

  it("eccezione di executeTool → errore al modello, il turno continua", async () => {
    const { deps, seen, steps } = makeDeps([callTools([{ id: "c1", name: "leggi_rosa", args: "{}" }]), reply("ok")], {
      executeTool: async () => {
        throw new Error("boom");
      },
    });
    const out = await runAgentLoop(initialState(), deps);
    expect(out.type).toBe("finished");
    expect(String(seen[1][2].content)).toContain("boom");
    expect(steps[1]).toMatchObject({ ok: false });
  });

  it("limite di giri", async () => {
    const responses = Array.from({ length: 20 }, (_, i) =>
      callTools([{ id: `c${i}`, name: "leggi_rosa", args: "{}" }], 1),
    );
    const { deps, chat, executeTool } = makeDeps(responses);
    const out = await runAgentLoop(initialState(), deps);
    expect(out.type).toBe("failed");
    if (out.type !== "failed") return;
    expect(out.error).toBe("limite di 8 giri di strumenti raggiunto");
    expect(chat).toHaveBeenCalledTimes(DEFAULT_LIMITS.maxRounds);
    expect(executeTool).toHaveBeenCalledTimes(8);
    expect(out.state.rounds).toBe(8);
    expectValidHistory(out.state.messages);
  });

  it("limite di giri personalizzato", async () => {
    const responses = Array.from({ length: 5 }, (_, i) => callTools([{ id: `c${i}`, name: "leggi_rosa", args: "{}" }]));
    const { deps, chat } = makeDeps(responses, { limits: { maxRounds: 2 } });
    const out = await runAgentLoop(initialState(), deps);
    expect(out).toMatchObject({ type: "failed", error: "limite di 2 giri di strumenti raggiunto" });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("limite di token", async () => {
    const { deps, chat, executeTool, steps } = makeDeps([
      callTools(
        [
          { id: "c1", name: "leggi_rosa", args: "{}" },
          { id: "c2", name: "proponi_scambio", args: "{}" },
        ],
        70_000,
      ),
      reply("mai"),
    ]);
    const out = await runAgentLoop(initialState(), deps);
    expect(out.type).toBe("failed");
    if (out.type !== "failed") return;
    expect(out.error).toContain("token");
    expect(out.error).toBe("limite di token per turno superato");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(out.state.tokens).toBe(70_005);
    // le chiamate richieste non vengono eseguite né messe in pausa
    expect(executeTool).not.toHaveBeenCalled();
    expect(steps.map((s) => s.type)).toEqual(["model"]);
    expect(out.state.queue).toEqual([]);
    expect(out.state.messages.slice(-2)).toEqual([
      { role: "tool", tool_call_id: "c1", content: "non eseguito: limite di token per turno superato" },
      { role: "tool", tool_call_id: "c2", content: "non eseguito: limite di token per turno superato" },
    ]);
    expectValidHistory(out.state.messages);
  });

  it("limite di token raggiunto con una risposta finale → finished", async () => {
    const { deps } = makeDeps([reply("eccola", 70_000)]);
    const out = await runAgentLoop(initialState(), deps);
    expect(out).toMatchObject({ type: "finished", content: "eccola" });
  });

  it("limite di tempo attivo e tempo in pausa escluso", async () => {
    let clock = 0;
    const responses: ChatResult[] = [
      callTools([{ id: "c1", name: "proponi_scambio", args: "{}" }]),
      callTools([{ id: "c2", name: "leggi_rosa", args: "{}" }]),
      callTools([{ id: "c3", name: "leggi_rosa", args: "{}" }]),
      reply("mai"),
    ];
    const chat = vi.fn(async () => {
      clock += 50_000; // ogni chiamata al modello dura 50 s
      return responses.shift()!;
    });
    const { deps, executeTool } = makeDeps([], { now: () => clock, chat });
    const out = await runAgentLoop(initialState(), deps);
    if (out.type !== "paused") throw new Error("atteso paused");
    expect(out.state.activeMs).toBe(50_000);

    clock += 9 * 60_000; // la pausa non conta come tempo attivo
    const resumed = resolvePending(JSON.parse(JSON.stringify(out.state)), out.pending, { ok: true, content: "ok" });
    const final = await runAgentLoop(resumed, deps);
    // 50 s → 100 s (seconda chiamata, c2 eseguito) → 150 s (terza: c3 non eseguito)
    expect(final).toMatchObject({ type: "failed", error: "tempo massimo del turno superato" });
    expect(chat).toHaveBeenCalledTimes(3);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(final.state.activeMs).toBe(150_000);
    expect(final.state.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c3",
      content: "non eseguito: tempo massimo del turno superato",
    });
    expectValidHistory(final.state.messages);
  });

  it("tempo massimo superato durante la chiamata al modello: tool non eseguiti", async () => {
    let clock = 0;
    const chat = vi.fn(async () => {
      clock += 130_000;
      return callTools([{ id: "c1", name: "leggi_rosa", args: "{}" }]);
    });
    const { deps, executeTool } = makeDeps([], { now: () => clock, chat });
    const out = await runAgentLoop(initialState(), deps);
    expect(out).toMatchObject({ type: "failed", error: "tempo massimo del turno superato" });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
    expectValidHistory(out.state.messages);
  });

  it("errore del modello → failed con il messaggio", async () => {
    const { deps, steps } = makeDeps([], {
      chat: async () => {
        throw new Error("gateway non raggiungibile");
      },
    });
    const out = await runAgentLoop(initialState(), deps);
    expect(out.type).toBe("failed");
    if (out.type !== "failed") return;
    expect(out.error).toContain("gateway non raggiungibile");
    expect(steps).toEqual([expect.objectContaining({ type: "model", ok: false, error: "gateway non raggiungibile" })]);
  });

  it("non modifica lo stato ricevuto", async () => {
    const state = initialState();
    const before = JSON.stringify(state);
    const { deps } = makeDeps([callTools([{ id: "c1", name: "leggi_rosa", args: "{}" }]), reply("ok")]);
    await runAgentLoop(state, deps);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("chat riceve il tempo attivo rimanente del turno", async () => {
    let clock = 0;
    const responses: ChatResult[] = [callTools([{ id: "c1", name: "leggi_rosa", args: "{}" }]), reply("ok")];
    const remaining: number[] = [];
    const chat = vi.fn(async (_messages: ChatCompletionMessageParam[], opts: { remainingMs: number }) => {
      remaining.push(opts.remainingMs);
      clock += 30_000;
      return responses.shift()!;
    });
    const { deps } = makeDeps([], { now: () => clock, chat });
    const state = { ...initialState(), activeMs: 10_000 };
    await runAgentLoop(state, deps);
    expect(remaining).toEqual([110_000, 80_000]);
  });

  it("pausa su un tool con proprietà sensibili: riassunto e argomenti pubblici oscurati", async () => {
    const cambiaPassword = makeTool({
      name: "cambia_password",
      description: "Cambia la password",
      requiresConfirmation: true,
      paramsSchema: {
        type: "object",
        properties: { utente: { type: "string" }, password: { type: "string", "x-sensitive": true } },
      },
    });
    const { deps } = makeDeps(
      [callTools([{ id: "c1", name: "cambia_password", args: '{"utente":"rosa","password":"segreta-123"}' }])],
      { tools: [cambiaPassword] },
    );
    const out = await runAgentLoop(initialState(), deps);
    if (out.type !== "paused") throw new Error("atteso paused");
    expect(out.pending.summary).not.toContain("segreta-123");
    expect(out.pending.summary).toContain("utente: rosa");
    expect(out.pending.publicArgs).toEqual({ utente: "rosa", password: "***" });
    // Gli argomenti veri restano per l'esecuzione alla ripresa
    expect(out.pending.args).toEqual({ utente: "rosa", password: "segreta-123" });
  });
});

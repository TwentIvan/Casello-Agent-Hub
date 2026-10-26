import { strToU8, zipSync } from "fflate";
import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatResult } from "../ai-gateway";
import {
  HISTORY_TOOL_OUTPUT_BUDGET,
  MAX_CORRECTIONS,
  MAX_TOOL_OUTPUT_CHARS,
  PHASE_MAX_ROUNDS,
  PHASE_NUDGE,
  PHASE_TOKEN_SHARES,
  runPhase,
  type PhaseBudget,
} from "./phase-loop";
import { PHASES } from "./schemas";
import { SOURCE_LIMITS, SourceTree } from "./source-tree";
import type { OpenApiDoc } from "./sources";

const SECRET_LINE = "const segreto = 'contenuto-riservato-42';";

const validMap = {
  stack: ["node"],
  structure: "monorepo",
  routes: [{ method: "GET", path: "/api/x", file: "src/a.ts" }],
  dataModels: [{ name: "Squadra", fields: ["id"] }],
  auth: { mechanism: "cookie", userToken: "header Authorization" },
  uiAreas: [{ name: "Squadre", description: "d", pages: ["/squadre"] }],
  summary: "riassunto-dell-esito",
};

const trees: SourceTree[] = [];
function makeTree(files: Record<string, string> = {}): SourceTree {
  const entries: Record<string, Uint8Array> = {};
  const all = { "src/a.ts": `${SECRET_LINE}\nexport const a = 1;\n`, ...files };
  for (const [k, v] of Object.entries(all)) entries[k] = strToU8(v);
  const tree = SourceTree.fromZip(zipSync(entries));
  trees.push(tree);
  return tree;
}
afterEach(async () => {
  await Promise.all(trees.splice(0).map((t) => t.dispose()));
});

const openapi: OpenApiDoc = {
  source: "https://app.example/openapi.json",
  operations: [{ method: "GET", path: "/api/squadre", operationId: "listSquadre", summary: "Elenco squadre" }],
  raw: {
    paths: {
      "/api/squadre": { get: { operationId: "listSquadre", summary: "Elenco squadre", responses: { "200": { description: "ok" } } } },
    },
  },
};

let callSeq = 0;
function call(name: string, args: unknown): ChatResult["toolCalls"][number] {
  callSeq += 1;
  return { id: `c${callSeq}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
}
function reply(toolCalls: ChatResult["toolCalls"], content: string | null = null, tokens = 10): ChatResult {
  return { content, toolCalls, promptTokens: tokens, completionTokens: 0 };
}

/** Chat finta a copione: ogni chiamata usa la risposta successiva (l'ultima si ripete). */
function scripted(replies: ChatResult[]) {
  const calls: { messages: ChatCompletionMessageParam[]; tools: ChatCompletionFunctionTool[] }[] = [];
  const chat = async (messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]): Promise<ChatResult> => {
    calls.push({ messages: structuredClone(messages), tools: tools.filter((t) => t.type === "function") });
    return replies[Math.min(calls.length - 1, replies.length - 1)]!;
  };
  return { chat, calls };
}

function budget(over: Partial<PhaseBudget> = {}): PhaseBudget {
  return { tokensUsed: 0, maxTokens: 400_000, deadline: 1_000_000, ...over };
}

function toolMessages(messages: ChatCompletionMessageParam[]): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => String(m.content));
}

function base(chat: ReturnType<typeof scripted>["chat"], over: Partial<Parameters<typeof runPhase>[0]> = {}) {
  const logs: string[] = [];
  const input: Parameters<typeof runPhase>[0] = {
    phase: "map",
    system: "sistema",
    user: "utente",
    tree: makeTree(),
    openapi: null,
    chat,
    budget: budget(),
    log: (m) => logs.push(m),
    now: () => 0,
    ...over,
  };
  return { input, logs };
}

describe("runPhase", () => {
  it("legge un file e consegna un esito valido", async () => {
    const s = scripted([
      reply([call("read_file", { path: "src/a.ts" })]),
      reply([call("submit_result", { result: validMap })]),
      reply([]),
    ]);
    const { input, logs } = base(s.chat);
    const out = await runPhase(input);
    expect(out).toEqual({ ok: true, result: validMap });
    expect(s.calls).toHaveLength(2);
    const read = toolMessages(s.calls[1]!.messages)[0]!;
    expect(read).toContain(`1: ${SECRET_LINE}`);
    expect(read).toContain("2: export const a = 1;");
    expect(logs).toContain("read_file src/a.ts (2 righe)");
    expect(input.budget.tokensUsed).toBe(20);
    // i messaggi iniziali sono system e user
    expect(s.calls[0]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("consegna non valida una volta, poi valida: invia la correzione", async () => {
    const s = scripted([
      reply([call("submit_result", { result: { ...validMap, stack: "node" } })]),
      reply([call("submit_result", { result: validMap })]),
    ]);
    const { input, logs } = base(s.chat);
    const out = await runPhase(input);
    expect(out.ok).toBe(true);
    const correction = toolMessages(s.calls[1]!.messages)[0]!;
    expect(correction).toContain("stack");
    expect(correction).toContain("deve essere un elenco");
    expect(correction).toContain("1/2");
    expect(logs).toContain("submit_result non valido (correzione 1/2)");
    expect(logs).toContain("submit_result valido");
  });

  it("tre consegne non valide: fallisce dopo 2 correzioni", async () => {
    const s = scripted([reply([call("submit_result", { result: { stack: 1 } })])]);
    const { input } = base(s.chat);
    const out = await runPhase(input);
    expect(MAX_CORRECTIONS).toBe(2);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("esito della fase map non valido dopo 2 correzioni");
      expect(out.error).toContain("stack");
    }
    expect(s.calls).toHaveLength(3);
  });

  it("submit_result senza il campo result conta come consegna non valida", async () => {
    const s = scripted([reply([call("submit_result", validMap)]), reply([call("submit_result", { result: validMap })])]);
    const { input } = base(s.chat);
    expect((await runPhase(input)).ok).toBe(true);
    expect(toolMessages(s.calls[1]!.messages)[0]).toContain("result");
  });

  it("read_file su un file inesistente: errore al modello e il ciclo continua", async () => {
    const s = scripted([
      reply([call("read_file", { path: "nope.ts" })]),
      reply([call("submit_result", { result: validMap })]),
    ]);
    const { input, logs } = base(s.chat);
    const out = await runPhase(input);
    expect(out.ok).toBe(true);
    expect(toolMessages(s.calls[1]!.messages)[0]).toMatch(/^Errore: File inesistente: nope\.ts/);
    expect(logs).toContain("read_file nope.ts (errore)");
  });

  it("argomenti malformati: errore in italiano al modello, il ciclo continua e il giro conta", async () => {
    const s = scripted([
      reply([call("read_file", "{non json"), call("read_file", { path: 3 }), call("list_dir", { depth: "x" })]),
      reply([call("submit_result", { result: validMap })]),
    ]);
    const { input } = base(s.chat);
    const out = await runPhase(input);
    expect(out.ok).toBe(true);
    const msgs = toolMessages(s.calls[1]!.messages);
    expect(msgs[0]).toContain("non sono JSON valido");
    expect(msgs[1]).toContain("path");
    expect(msgs[1]).toContain("stringa");
    expect(msgs[2]).toContain("path");
  });

  it("strumento sconosciuto: errore al modello", async () => {
    const s = scripted([reply([call("rm_rf", {})]), reply([call("submit_result", { result: validMap })])]);
    const { input } = base(s.chat);
    expect((await runPhase(input)).ok).toBe(true);
    expect(toolMessages(s.calls[1]!.messages)[0]).toContain('lo strumento "rm_rf" non esiste');
  });

  it("più chiamate nello stesso messaggio: risponde a tutte, la consegna per ultima", async () => {
    const submit = call("submit_result", { result: { ...validMap, stack: 1 } });
    const read = call("read_file", { path: "src/a.ts" });
    const s = scripted([reply([submit, read]), reply([call("submit_result", { result: validMap })])]);
    const { input } = base(s.chat);
    expect((await runPhase(input)).ok).toBe(true);
    const tools = s.calls[1]!.messages.filter((m) => m.role === "tool") as { tool_call_id: string; content: string }[];
    expect(tools.map((t) => t.tool_call_id)).toEqual([read.id, submit.id]);
  });

  it("una consegna valida chiude la fase anche dopo letture nello stesso messaggio", async () => {
    const s = scripted([reply([call("list_dir", { path: "" }), call("submit_result", { result: validMap })])]);
    const { input, logs } = base(s.chat);
    expect(await runPhase(input)).toEqual({ ok: true, result: validMap });
    expect(s.calls).toHaveLength(1);
    expect(logs[0]).toBe("list_dir / (1 voce)");
  });

  it("risposta senza strumenti: promemoria, contato come giro", async () => {
    const s = scripted([reply([], "ho finito"), reply([call("submit_result", { result: validMap })])]);
    const { input } = base(s.chat);
    expect((await runPhase(input)).ok).toBe(true);
    const last = s.calls[1]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("consegna l'esito con submit_result");
  });

  describe("budget della fase", () => {
    const isNudge = (m: ChatCompletionMessageParam) => m.role === "user" && m.content === PHASE_NUDGE;
    const nudges = (messages: ChatCompletionMessageParam[]) => messages.filter(isNudge).length;

    function expectPairing(messages: ChatCompletionMessageParam[]) {
      const ids = messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((t) => t.id) : []));
      const replies = messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
      // ogni tool_call ha esattamente una risposta (le consegne rispondono dopo le letture)
      expect([...replies].sort()).toEqual([...ids].sort());
      expect(new Set(ids).size).toBe(ids.length);
    }

    it("quote per fase: lasciano margine sotto il tetto complessivo", () => {
      expect(Object.keys(PHASE_TOKEN_SHARES).sort()).toEqual([...PHASES].sort());
      // somma ≤ 0,9: i giri di margine e le correzioni consumano token oltre la quota
      const sum = Object.values(PHASE_TOKEN_SHARES).reduce((a, b) => a + b, 0);
      expect(sum).toBeLessThanOrEqual(0.9);
      expect(sum).toBeCloseTo(0.88, 10);
      expect(PHASE_TOKEN_SHARES).toEqual({
        map: 0.22,
        capabilities: 0.13,
        catalog: 0.18,
        agents: 0.13,
        completion: 0.13,
        evolution: 0.09,
      });
    });

    const invalid = () => reply([call("submit_result", { result: { ...validMap, stack: "node" } })], null, 10);

    it("consegne non valide nel margine: le correzioni restano tutte disponibili", async () => {
      const s = scripted([
        reply([call("read_file", { path: "src/a.ts" })], null, 900),
        invalid(), // N+1
        invalid(), // N+2
        reply([call("submit_result", { result: validMap })]), // N+3: ultima correzione
      ]);
      const { input } = base(s.chat, { phaseQuota: 1_000 });
      expect(await runPhase(input)).toEqual({ ok: true, result: validMap });
      expect(s.calls).toHaveLength(4);
      expectPairing(s.calls[3]!.messages);
    });

    it("margine esaurito dopo una consegna non valida: l'errore riporta i problemi", async () => {
      const s = scripted([
        reply([call("read_file", { path: "src/a.ts" })], null, 900),
        invalid(), // N+1
        invalid(), // N+2: correzioni finite al prossimo errore
        reply([call("read_file", { path: "src/a.ts" })]), // N+3: nessuna consegna
        reply([call("submit_result", { result: validMap })]),
      ]);
      const { input } = base(s.chat, { phaseQuota: 1_000 });
      const out = await runPhase(input);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error).toMatch(/^fase map: esito non consegnato entro il budget della fase; ultimo esito non valido: /);
        expect(out.error).toContain("stack");
      }
      expect(s.calls).toHaveLength(4);
    });

    it("giro del sollecito con letture e consegna non valida: risposte appaiate, sollecito in coda", async () => {
      const s = scripted([
        reply([call("read_file", { path: "src/a.ts" }), call("submit_result", { result: { stack: 1 } }), call("list_dir", { path: "" })], null, 900),
        reply([call("submit_result", { result: validMap })]),
      ]);
      const { input } = base(s.chat, { phaseQuota: 1_000 });
      expect((await runPhase(input)).ok).toBe(true);
      const msgs = s.calls[1]!.messages;
      expectPairing(msgs);
      expect(msgs.slice(-5).map((m) => m.role)).toEqual(["assistant", "tool", "tool", "tool", "user"]);
      expect(isNudge(msgs.at(-1)!)).toBe(true);
      expect(String(msgs.at(-2)!.content)).toContain("Esito non valido");
    });

    it("all'80% della quota: sollecito una volta, dopo le risposte agli strumenti; poi consegna valida", async () => {
      const s = scripted([
        reply([call("read_file", { path: "src/a.ts" })], null, 300),
        reply([call("list_dir", { path: "" })], null, 300),
        // terzo giro: 900/1000 token → sollecito dopo le due risposte
        reply([call("read_file", { path: "src/a.ts" }), call("list_dir", { path: "src" })], null, 300),
        reply([call("submit_result", { result: validMap })], null, 300),
      ]);
      const { input, logs } = base(s.chat, { phaseQuota: 1_000 });
      expect(await runPhase(input)).toEqual({ ok: true, result: validMap });
      expect(s.calls).toHaveLength(4);
      expect(s.calls.slice(0, 3).every((c) => nudges(c.messages) === 0)).toBe(true);
      const msgs = s.calls[3]!.messages;
      expect(nudges(msgs)).toBe(1);
      expect(isNudge(msgs.at(-1)!)).toBe(true);
      expect(msgs.at(-2)!.role).toBe("tool");
      expect(msgs.at(-3)!.role).toBe("tool");
      expect(msgs.at(-4)!.role).toBe("assistant");
      expectPairing(msgs);
      expect(logs.filter((l) => l.includes("budget della fase"))).toHaveLength(1);
    });

    it("dopo il sollecito continua a leggere: fallisce dopo altri 2 giri", async () => {
      const s = scripted(Array.from({ length: 6 }, () => reply([call("read_file", { path: "src/a.ts" })], null, 400)));
      const { input } = base(s.chat, { phaseQuota: 1_000 });
      const out = await runPhase(input);
      // 2 giri (800/1000) → sollecito, poi 2 giri di grazia
      expect(out).toEqual({ ok: false, error: "fase map: esito non consegnato entro il budget della fase" });
      expect(s.calls).toHaveLength(4);
      expect(nudges(s.calls[1]!.messages)).toBe(0);
      expect(isNudge(s.calls[2]!.messages.at(-1)!)).toBe(true);
      // il sollecito non si ripete
      expect(nudges(s.calls[3]!.messages)).toBe(1);
      expectPairing(s.calls[3]!.messages);
      expect(input.budget.tokensUsed).toBe(1_600);
    });

    it("la quota conta solo i token della fase, non quelli già usati dall'analisi", async () => {
      const s = scripted([
        reply([call("read_file", { path: "src/a.ts" })], null, 300),
        reply([call("submit_result", { result: validMap })], null, 300),
      ]);
      const { input } = base(s.chat, { phaseQuota: 1_000, budget: budget({ tokensUsed: 100_000 }) });
      expect((await runPhase(input)).ok).toBe(true);
      expect(nudges(s.calls[1]!.messages)).toBe(0);
    });

    it(`all'80% dei ${PHASE_MAX_ROUNDS} giri: sollecito, poi fallisce dopo altri 2 giri`, async () => {
      expect(PHASE_MAX_ROUNDS).toBe(25);
      const s = scripted([reply([call("list_dir", { path: "src" })])]);
      const { input } = base(s.chat);
      const out = await runPhase(input);
      expect(out).toEqual({ ok: false, error: "fase map: esito non consegnato entro il budget della fase" });
      expect(nudges(s.calls[19]!.messages)).toBe(0);
      expect(isNudge(s.calls[20]!.messages.at(-1)!)).toBe(true);
      expect(s.calls).toHaveLength(22);
    });

    it("sollecito dopo una risposta senza strumenti: resta l'ultimo messaggio", async () => {
      const s = scripted([reply([], "penso", 900), reply([call("submit_result", { result: validMap })])]);
      const { input } = base(s.chat, { phaseQuota: 1_000 });
      expect((await runPhase(input)).ok).toBe(true);
      const msgs = s.calls[1]!.messages;
      // un solo messaggio utente dopo la risposta: il sollecito al posto del promemoria
      expect(msgs.slice(-2).map((m) => m.role)).toEqual(["assistant", "user"]);
      expect(isNudge(msgs.at(-1)!)).toBe(true);
      expect(nudges(msgs)).toBe(1);
    });
  });

  it("token oltre il budget: fallisce prima della chiamata successiva", async () => {
    const s = scripted([reply([call("list_dir", { path: "src" })], null, 150)]);
    const { input } = base(s.chat, { budget: budget({ maxTokens: 100 }) });
    const out = await runPhase(input);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("token");
    expect(s.calls).toHaveLength(1);
    expect(input.budget.tokensUsed).toBe(150);
  });

  it("budget di token già esaurito: nessuna chiamata al modello", async () => {
    const s = scripted([reply([])]);
    const { input } = base(s.chat, { budget: budget({ tokensUsed: 100, maxTokens: 100 }) });
    const out = await runPhase(input);
    expect(out.ok).toBe(false);
    expect(s.calls).toHaveLength(0);
  });

  it("scadenza superata: fallisce nominando il tempo", async () => {
    let t = 0;
    const s = scripted([reply([call("list_dir", { path: "src" })])]);
    const { input } = base(s.chat, { budget: budget({ deadline: 30 }), now: () => (t += 10) });
    const out = await runPhase(input);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("tempo");
    expect(s.calls.length).toBeGreaterThan(0);
    expect(s.calls.length).toBeLessThan(3);
  });

  it("errore della chiamata al modello: esito fallito", async () => {
    const { input } = base(async () => {
      throw new Error("gateway giù");
    });
    const out = await runPhase(input);
    expect(out).toEqual({ ok: false, error: "fase map: errore nella chiamata al modello: gateway giù" });
  });

  it("senza codice non offre list_dir/read_file/search; con OpenAPI offre le operazioni", async () => {
    const s = scripted([
      reply([call("list_operations", {}), call("read_operation", { method: "get", path: "/api/squadre" }), call("read_file", { path: "src/a.ts" })]),
      reply([call("submit_result", { result: validMap })]),
    ]);
    const { input, logs } = base(s.chat, { tree: null, openapi });
    expect((await runPhase(input)).ok).toBe(true);
    const names = s.calls[0]!.tools.map((t) => t.function.name);
    expect(names).toEqual(["list_operations", "read_operation", "submit_result"]);
    const msgs = toolMessages(s.calls[1]!.messages);
    expect(msgs[0]).toContain("GET /api/squadre — listSquadre — Elenco squadre");
    expect(msgs[1]).toContain("operationId: listSquadre");
    expect(msgs[2]).toContain('lo strumento "read_file" non esiste');
    expect(logs).toContain("list_operations (1 operazione)");
    expect(logs).toContain("read_operation GET /api/squadre");
  });

  it("con il solo codice non offre gli strumenti OpenAPI", async () => {
    const s = scripted([reply([call("submit_result", { result: validMap })])]);
    const { input } = base(s.chat);
    await runPhase(input);
    const tools = s.calls[0]!.tools;
    expect(tools.map((t) => t.function.name)).toEqual(["list_dir", "read_file", "search", "submit_result"]);
    const submit = tools.find((t) => t.function.name === "submit_result")!;
    expect(submit.function.parameters).toEqual({
      type: "object",
      properties: { result: { type: "object" } },
      required: ["result"],
    });
  });

  it("i log non contengono il contenuto dei file, i risultati della ricerca né l'esito", async () => {
    const s = scripted([
      reply([
        call("read_file", { path: "src/a.ts" }),
        call("search", { pattern: "segreto" }),
        call("search", { pattern: "segr.to", regex: true, glob: "src/**" }),
      ]),
      reply([call("submit_result", { result: { ...validMap, stack: 1 } })]),
      reply([call("submit_result", { result: validMap })]),
    ]);
    const { input, logs } = base(s.chat);
    expect((await runPhase(input)).ok).toBe(true);
    const all = logs.join("\n");
    expect(all).not.toContain("contenuto-riservato-42");
    expect(all).not.toContain("riassunto-dell-esito");
    expect(logs).toContain('search "segreto" (1 risultato)');
    expect(toolMessages(s.calls[1]!.messages)[1]).toContain(`src/a.ts:1: ${SECRET_LINE}`);
  });

  it("read_file lungo: numera le righe e indica come continuare", async () => {
    const big = Array.from({ length: 1_000 }, (_, i) => `riga ${i + 1}`).join("\n");
    const s = scripted([
      reply([call("read_file", { path: "big.ts", fromLine: 10 })]),
      reply([call("submit_result", { result: validMap })]),
    ]);
    const { input, logs } = base(s.chat, { tree: makeTree({ "big.ts": big }) });
    await runPhase(input);
    const msg = toolMessages(s.calls[1]!.messages)[0]!;
    expect(SOURCE_LIMITS.maxReadLines).toBe(200);
    expect(msg).toContain("10: riga 10");
    expect(msg).toContain("209: riga 209");
    expect(msg).not.toContain("210: riga 210");
    expect(msg).toContain("fromLine=210");
    expect(msg).toContain("1000");
    expect(logs).toContain("read_file big.ts (200 righe)");
  });

  it("read_file con righe lunghe: resta sotto il tetto dell'output e indica come continuare", async () => {
    expect(MAX_TOOL_OUTPUT_CHARS).toBe(12_000);
    const wide = Array.from({ length: 1_000 }, (_, i) => `${"y".repeat(150)}${i + 1}`).join("\n");
    const s = scripted([
      reply([call("read_file", { path: "src/molto/annidato/wide.ts", fromLine: 1 })]),
      reply([call("submit_result", { result: validMap })]),
    ]);
    const { input } = base(s.chat, { tree: makeTree({ "src/molto/annidato/wide.ts": wide }) });
    await runPhase(input);
    const msg = toolMessages(s.calls[1]!.messages)[0]!;
    expect(msg.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(msg).toMatch(/continua con fromLine=\d+/);
    expect(msg).not.toContain("troncato: output oltre");
  });

  it("list_operations a pagine: suggerimento in coda e offset per la pagina successiva", async () => {
    const ops = Array.from({ length: 300 }, (_, i) => ({
      method: "GET",
      path: `/api/risorse/${String(i).padStart(3, "0")}/dettaglio`,
      operationId: `operazioneConUnNomeAbbastanzaLungo${i}`,
      summary: `Descrizione dell'operazione numero ${i} con un testo di lunghezza realistica`,
    }));
    const big: OpenApiDoc = { source: "x", operations: ops, raw: { paths: {} } };
    // il modello legge la prima pagina e chiede la successiva con l'offset del suggerimento
    const pages: string[] = [];
    let next = -1;
    const chat = async (messages: ChatCompletionMessageParam[]): Promise<ChatResult> => {
      const last = messages.at(-1);
      if (last?.role === "tool") pages.push(String(last.content));
      if (pages.length === 0) return reply([call("list_operations", {})]);
      if (pages.length === 1) {
        next = Number(/usa offset=(\d+) o un prefix\]$/.exec(pages[0]!)?.[1]);
        return reply([call("list_operations", { offset: next })]);
      }
      return reply([call("submit_result", { result: validMap })]);
    };
    const { input, logs } = base(chat, { tree: null, openapi: big });
    expect((await runPhase(input)).ok).toBe(true);
    const [first, second] = pages;
    expect(first!.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(first!.startsWith("Operazioni 1-")).toBe(true);
    expect(first).toMatch(/\n\[altre \d+ operazioni: usa offset=\d+ o un prefix\]$/);
    expect(next).toBeGreaterThan(50);
    expect(next).toBeLessThan(300);
    expect(first).toContain(`/api/risorse/${String(next - 1).padStart(3, "0")}/dettaglio`);
    expect(first).not.toContain(`/api/risorse/${String(next).padStart(3, "0")}/dettaglio`);
    expect(second!.startsWith(`Operazioni ${next + 1}-`)).toBe(true);
    expect(second).toContain(`/api/risorse/${String(next).padStart(3, "0")}/dettaglio`);
    expect(second).not.toContain(`/api/risorse/${String(next - 1).padStart(3, "0")}/dettaglio`);
    expect(logs).toContain(`list_operations offset=${next} (300 operazioni)`);
  });

  it("list_operations: offset oltre la fine e filtro per prefisso", async () => {
    const ops = Array.from({ length: 300 }, (_, i) => ({
      method: "GET",
      path: `/api/risorse/${String(i).padStart(3, "0")}`,
      operationId: null,
      summary: null,
    }));
    const big: OpenApiDoc = { source: "x", operations: ops, raw: { paths: {} } };
    const s = scripted([
      reply([call("list_operations", { offset: 9_999 }), call("list_operations", { prefix: "/api/risorse/29" }), call("list_operations", { prefix: "/nope" })]),
      reply([call("submit_result", { result: validMap })]),
    ]);
    const { input } = base(s.chat, { tree: null, openapi: big });
    expect((await runPhase(input)).ok).toBe(true);
    const [beyond, prefixed, none] = toolMessages(s.calls[1]!.messages);
    expect(beyond).toBe("Nessuna operazione oltre offset=9999 (sono 300).");
    expect(prefixed!.split("\n")).toEqual(Array.from({ length: 10 }, (_, i) => `GET /api/risorse/29${i}`));
    expect(none).toBe("Nessuna operazione con prefisso /nope nel documento OpenAPI.");
  });

  it("list_dir e search con output lunghi: il suggerimento resta dentro il tetto", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 400; i++) files[`src/${"nome-di-file-molto-lungo-".repeat(3)}${i}.ts`] = `${"z".repeat(180)} trovami
`;
    const s = scripted([
      reply([call("list_dir", { path: "src" }), call("search", { pattern: "trovami" })]),
      reply([call("submit_result", { result: validMap })]),
    ]);
    const { input } = base(s.chat, { tree: makeTree(files) });
    expect((await runPhase(input)).ok).toBe(true);
    const [dir, found] = toolMessages(s.calls[1]!.messages);
    expect(dir!.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(dir).toMatch(/\n\[\.\.\.altre \d+ voci non mostrate: elenca una sottocartella o riduci depth\]$/);
    expect(found!.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(found).toMatch(/\n\[risultati limitati a \d+: restringi la ricerca/);
    expect(found).not.toContain("troncato: output oltre");
  });

  it("search con molti risultati: segnala il taglio", async () => {
    const many = Array.from({ length: 300 }, () => "match").join("\n");
    const s = scripted([reply([call("search", { pattern: "match" })]), reply([call("submit_result", { result: validMap })])]);
    const { input } = base(s.chat, { tree: makeTree({ "m.ts": many }) });
    await runPhase(input);
    const msg = toolMessages(s.calls[1]!.messages)[0]!;
    expect(msg).toContain("m.ts:100: match");
    expect(msg).toContain("risultati limitati");
  });

  describe("compattazione della cronologia", () => {
    const size = (messages: ChatCompletionMessageParam[]) =>
      messages.reduce((n, m) => n + JSON.stringify(m).length, 0);

    async function manyReads(rounds: number) {
      // file da ~100 caratteri per riga: ogni lettura arriva al tetto di caratteri per chiamata
      const line = "x".repeat(95);
      const files: Record<string, string> = {};
      for (let i = 0; i < rounds; i++) {
        files[`src/f${i}.ts`] = Array.from({ length: 400 }, (_, n) => `${line}${i}-${n}`).join("\n");
      }
      const s = scripted([
        ...Array.from({ length: rounds }, (_, i) => reply([call("read_file", { path: `src/f${i}.ts` })])),
        reply([call("submit_result", { result: { ...validMap, stack: "node" } })]),
        reply([call("submit_result", { result: validMap })]),
      ]);
      const { input } = base(s.chat, { tree: makeTree(files) });
      const out = await runPhase(input);
      return { s, out };
    }

    it("dopo molte letture grandi i messaggi inviati restano sotto un tetto", async () => {
      const rounds = 20;
      const { s, out } = await manyReads(rounds);
      expect(out.ok).toBe(true);
      expect(s.calls).toHaveLength(rounds + 2);
      // budget della cronologia + l'ultima lettura (sempre intera) + messaggi brevi
      expect(HISTORY_TOOL_OUTPUT_BUDGET).toBe(24_000);
      const bound = HISTORY_TOOL_OUTPUT_BUDGET + MAX_TOOL_OUTPUT_CHARS + 3_000;
      for (const c of s.calls) expect(size(c.messages)).toBeLessThan(bound);
      const last = s.calls.at(-1)!.messages;
      const tools = toolMessages(last);
      // le letture più vecchie sono segnaposto con nome e percorso, senza contenuto del file
      expect(tools[0]).toBe("[output di read_file src/f0.ts omesso per spazio: rileggilo se serve]");
      expect(tools[0]).not.toContain("xxxx");
      // la più recente è intera; la correzione della consegna non valida resta intatta
      expect(tools[rounds - 1]).toContain(`File src/f${rounds - 1}.ts`);
      expect(tools[rounds]).toContain("Esito non valido");
      expect(tools[rounds]).toContain("forma dell'esempio");
    });

    it("ogni tool_call conserva esattamente una risposta", async () => {
      const { s } = await manyReads(12);
      for (const c of s.calls) {
        const ids = c.messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((t) => t.id) : []));
        const replies = c.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
        expect(replies).toEqual(ids);
        expect(new Set(ids).size).toBe(ids.length);
      }
      // system e user restano in testa
      expect(s.calls.at(-1)!.messages.slice(0, 2).map((m) => m.content)).toEqual(["sistema", "utente"]);
    });

    it("le letture parallele del giro corrente arrivano intere al modello", async () => {
      const line = "x".repeat(95);
      const files: Record<string, string> = {};
      const paths = [0, 1, 2].map((i) => `src/f${i}.ts`);
      paths.forEach((p, i) => (files[p] = Array.from({ length: 400 }, (_, n) => `${line}${i}-${n}`).join("\n")));
      const s = scripted([
        reply(paths.map((path) => call("read_file", { path }))),
        reply([call("submit_result", { result: validMap })]),
      ]);
      const { input } = base(s.chat, { tree: makeTree(files) });
      expect((await runPhase(input)).ok).toBe(true);
      // le tre letture insieme superano il budget, ma nessuna è un segnaposto
      const tools = toolMessages(s.calls[1]!.messages);
      expect(tools.reduce((n, t) => n + t!.length, 0)).toBeGreaterThan(HISTORY_TOOL_OUTPUT_BUDGET);
      paths.forEach((p, i) => expect(tools[i]).toContain(`File ${p}`));
    });
  });
});

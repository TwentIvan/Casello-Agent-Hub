import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { db, pool, aiAccountsTable, aiModelsTable, analysesTable, appsTable, usersTable, type LocalJob } from "@workspace/db";
import { mcpClientFor, toolText } from "../../../test/fake-local-agent";
import { MAX_TOOL_OUTPUT_CHARS, READ_TOOLS, runPhase } from "../architect/phase-loop";
import { SourceTree } from "../architect/source-tree";
import { ensureProviderRegistry } from "../catalog/provider-registry";
import type { OpenApiDoc } from "../architect/sources";
import { closeAnalysisContext, MAX_INVALID_SUBMITS_PER_ITEM, openAnalysisContext } from "./architect-tools";
import { claimJob, createLocalJob, jobByToken, runItem, type ItemResult } from "./jobs";
import { registerMachine } from "./machines";

// Strumenti MCP dei lavori `analysis`: gli strumenti di lettura dell'architetto (stesso testo di runPhase) e la
// consegna della fase, che chiude il compito in corso.

const SECRET_LINE = "const segreto = 'contenuto-riservato-42';";

const validMap = {
  stack: ["node"],
  structure: "monorepo",
  routes: [{ method: "GET", path: "/api/x", file: "src/a.ts" }],
  dataModels: [{ name: "Squadra", fields: ["id"] }],
  auth: { mechanism: "cookie", userToken: "header Authorization" },
  uiAreas: [{ name: "Squadre", description: "d", pages: ["/squadre"] }],
  summary: "riassunto",
};

const openapi: OpenApiDoc = {
  source: "https://app.example/openapi.json",
  operations: [{ method: "GET", path: "/api/squadre", operationId: "listSquadre", summary: "Elenco squadre" }],
  raw: { paths: { "/api/squadre": { get: { operationId: "listSquadre", responses: { "200": { description: "ok" } } } } } },
};

let tree: SourceTree;
let analysisId: number;
let jobId: number;
let jobToken: string;
let logs: string[];
let controllers: AbortController[] = [];
let closers: Array<() => Promise<void>> = [];

function signal() {
  const ac = new AbortController();
  controllers.push(ac);
  return ac.signal;
}

async function client(): Promise<Client> {
  const job = (await jobByToken(jobToken)) as LocalJob;
  const c = await mcpClientFor(job);
  closers.push(c.close);
  return c.client;
}

/** Compito in corso del lavoro (come lo pubblica runPhaseDelegated); `done` risolve alla sua fine. */
async function publishItem(): Promise<{ done: Promise<ItemResult> }> {
  const done = runItem(jobId, { prompt: "fase", resume: false }, signal());
  for (let i = 0; i < 100; i++) {
    if ((await jobByToken(jobToken))?.currentItem) return { done };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("compito non pubblicato");
}

// Il provider `local_agent` dell'account "Agente locale" sta nel registro dei provider
beforeAll(async () => {
  await ensureProviderRegistry();
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  const [user] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
  const { machine } = await registerMachine(user!.id, "MacBook");
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: user!.id, name: "API", provider: "custom", baseUrl: "https://api.example.com/v1", status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "m" }).returning();
  const [app] = await db.insert(appsTable).values({ name: "App", slug: "app", baseUrl: "https://app.example.com" }).returning();
  const [analysis] = await db
    .insert(analysesTable)
    .values({ appId: app!.id, model: "m", sources: { code: "zip", openapi: true, description: false }, maxTokens: 1000 })
    .returning();
  analysisId = analysis!.id;
  const job = await createLocalJob({
    userId: user!.id,
    machineId: machine.id,
    kind: "analysis",
    analysisId,
    fallbackAiModelId: model!.id,
    origin: "console",
  });
  jobId = job.id;
  ({ jobToken } = await claimJob(job.id, { by: "runner", machineId: machine.id }));
  tree = SourceTree.fromZip(zipSync({ "src/a.ts": strToU8(`${SECRET_LINE}\nexport const a = 1;\n`) }));
  logs = [];
});

afterEach(async () => {
  for (const ac of controllers) ac.abort();
  controllers = [];
  for (const close of closers.splice(0)) await close();
  closeAnalysisContext(analysisId);
  await tree?.dispose();
});

describe("strumenti MCP dell'architetto", () => {
  it("elenca gli strumenti di lettura delle sorgenti disponibili (stessi schemi) e submit_phase_result", async () => {
    openAnalysisContext(analysisId, { tree, openapi: null, log: (m) => logs.push(m) });
    const { tools } = await (await client()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_job", "list_dir", "read_file", "search", "submit_phase_result"]);
    const readFile = tools.find((t) => t.name === "read_file")!;
    expect(readFile.description).toBe(READ_TOOLS.read_file.function.description);
    expect(readFile.inputSchema).toEqual(READ_TOOLS.read_file.function.parameters);

    closeAnalysisContext(analysisId);
    openAnalysisContext(analysisId, { tree: null, openapi, log: (m) => logs.push(m) });
    const names = (await (await client()).listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_job", "list_operations", "read_operation", "submit_phase_result"]);
  });

  it("read_file restituisce lo stesso testo di runPhase e registra la riga nel log dell'analisi", async () => {
    // Testo che runPhase restituisce al modello per la stessa lettura
    let fromRunPhase = "";
    let calls = 0;
    await runPhase({
      phase: "map",
      system: "s",
      user: "u",
      tree,
      openapi: null,
      budget: { tokensUsed: 0, maxTokens: 100_000, deadline: Number.MAX_SAFE_INTEGER },
      log: () => {},
      chat: async (messages) => {
        calls += 1;
        if (calls === 1) {
          return { content: null, toolCalls: [{ id: "r1", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) }], promptTokens: 1, completionTokens: 0 };
        }
        fromRunPhase = String(messages.find((m) => m.role === "tool")!.content);
        return { content: null, toolCalls: [{ id: "s1", name: "submit_result", arguments: JSON.stringify({ result: validMap }) }], promptTokens: 1, completionTokens: 0 };
      },
    });
    expect(fromRunPhase).toContain(SECRET_LINE);

    const ctx = openAnalysisContext(analysisId, { tree, openapi: null, log: (m) => logs.push(m) });
    ctx.phase = "map";
    const out = toolText(await (await client()).callTool({ name: "read_file", arguments: { path: "src/a.ts" } }));
    expect(out).toEqual({ text: fromRunPhase, isError: false });
    expect(logs).toEqual(["read_file src/a.ts (2 righe)"]);
  });

  it("errori di lettura: testo d'errore come per il modello, mai un'eccezione", async () => {
    openAnalysisContext(analysisId, { tree, openapi: null, log: (m) => logs.push(m) });
    const c = await client();
    expect(toolText(await c.callTool({ name: "read_file", arguments: { path: "nope.ts" } })).text).toMatch(/^Errore: /);
    expect(toolText(await c.callTool({ name: "read_file", arguments: { path: 3 } })).text).toMatch(/argomenti di "read_file" non validi/);
    expect(logs).toEqual(["read_file nope.ts (errore)", "read_file (argomenti non validi)"]);
  });

  it("output lungo troncato come in runPhase", async () => {
    const big = SourceTree.fromZip(zipSync({ "big.ts": strToU8(Array.from({ length: 200 }, () => "x".repeat(200)).join("\n")) }));
    try {
      openAnalysisContext(analysisId, { tree: big, openapi: null, log: () => {} });
      const { text } = toolText(await (await client()).callTool({ name: "read_file", arguments: { path: "big.ts" } }));
      expect(text.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS + 100);
      expect(text).toContain("troncato");
    } finally {
      await big.dispose();
    }
  });

  it("submit_phase_result non valido: errore con i problemi, il compito resta aperto; valido: compito completato", async () => {
    const ctx = openAnalysisContext(analysisId, { tree, openapi: null, log: (m) => logs.push(m) });
    ctx.phase = "map";
    const item = await publishItem();
    let settled = false;
    void item.done.then(() => (settled = true));
    const c = await client();

    const bad = toolText(await c.callTool({ name: "submit_phase_result", arguments: { result: { stack: "x" } } }));
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Esito non valido/);
    expect(bad.text).toMatch(/- stack: /);
    const missing = toolText(await c.callTool({ name: "submit_phase_result", arguments: {} }));
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/result: campo obbligatorio/);
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    const ok = toolText(await c.callTool({ name: "submit_phase_result", arguments: { result: validMap } }));
    expect(ok).toEqual({ text: "consegna ricevuta: fase completata, termina ora", isError: false });
    const result = await item.done;
    expect(result.completion).toEqual(validMap);
    expect(logs).toEqual(["submit_phase_result non valido", "submit_phase_result non valido", "submit_phase_result valido"]);
  });

  it("oltre 5 consegne non valide nello stesso compito: fase interrotta e compito chiuso", async () => {
    const ctx = openAnalysisContext(analysisId, { tree, openapi: null, log: (m) => logs.push(m) });
    ctx.phase = "map";
    const item = await publishItem();
    const c = await client();
    for (let i = 0; i < MAX_INVALID_SUBMITS_PER_ITEM; i++) {
      const bad = toolText(await c.callTool({ name: "submit_phase_result", arguments: { result: { stack: "x" } } }));
      expect(bad.text).toMatch(/Esito non valido/);
    }
    const last = toolText(await c.callTool({ name: "submit_phase_result", arguments: { result: { stack: "x" } } }));
    expect(last).toEqual({ text: "troppe consegne non valide: fase interrotta", isError: true });
    const result = await item.done;
    expect(result.completion).toBeDefined();
    expect(result.completion).not.toEqual(validMap);
    expect(logs.at(-1)).toBe("submit_phase_result non valido (troppe consegne: fase interrotta)");
  });

  it("senza compito in corso la consegna è rifiutata", async () => {
    const ctx = openAnalysisContext(analysisId, { tree, openapi: null, log: () => {} });
    ctx.phase = "map";
    const out = toolText(await (await client()).callTool({ name: "submit_phase_result", arguments: { result: validMap } }));
    expect(out.isError).toBe(true);
    expect(out.text).toBe("nessuna fase in corso");
  });

  it("contesto dell'analisi assente (es. dopo un riavvio): lavoro scaduto", async () => {
    const c = await client();
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("submit_phase_result");
    expect(toolText(await c.callTool({ name: "read_file", arguments: { path: "src/a.ts" } }))).toEqual({ text: "lavoro scaduto", isError: true });
    expect(toolText(await c.callTool({ name: "submit_phase_result", arguments: { result: validMap } }))).toEqual({
      text: "lavoro scaduto",
      isError: true,
    });
  });
});

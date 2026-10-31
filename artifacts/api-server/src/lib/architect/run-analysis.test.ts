import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  usersTable,
  analysesTable,
  analysisItemsTable,
  appToolsTable,
  appsTable,
  type AnalysisLogEntry,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import { LEGACY_GATEWAY_PROVIDER } from "../ai/providers";
import { ensureLegacyGatewayProvider } from "../../../test/legacy-gateway";
import { allowTestLoopback } from "../../../test/fake-provider";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import type { GithubConfig } from "../github/config";
import {
  ANALYSIS_DEFAULT_MAX_TOKENS,
  ANALYSIS_LOG_MAX,
  ANALYSIS_MAX_MS,
  appendLog,
  failInterruptedAnalyses,
  startAnalysis,
} from "./run-analysis";
import type { PhaseName } from "./schemas";

// Contenuto del file di prova e token GitHub: non devono mai finire nel log né negli errori
const FILE_SECRET = "CONTENUTO_RISERVATO_DEL_FILE_42";
const GITHUB_TOKEN = "ghp_TOKENSEGRETISSIMO0123456789";

const ENV_KEYS = ["CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

// --- Esiti validi delle fasi ---

const evidence = [{ source: "code", location: "src/a.ts:1" }];

const toolProposal = (over: Record<string, unknown> = {}) => ({
  name: "list_teams",
  description: "Elenco squadre",
  kind: "http",
  identity: "user",
  requiresConfirmation: false,
  readOnly: true,
  paramsSchema: { type: "object", properties: { q: { type: "string" } } },
  definition: { method: "GET", path: "/teams", paramLocations: { q: "query" } },
  area: "Squadre",
  evidence,
  needsVerification: false,
  ...over,
});

const RESULTS: Record<PhaseName, unknown> = {
  map: {
    stack: ["Node", "Express"],
    structure: "src/ con le route",
    routes: [{ method: "GET", path: "/teams", file: "src/a.ts" }],
    dataModels: [{ name: "Team", fields: ["id", "name"] }],
    auth: { mechanism: "Bearer", userToken: "login" },
    uiAreas: [{ name: "Squadre", description: "Gestione", pages: ["/teams"] }],
    summary: "App di prova",
  },
  capabilities: {
    areas: [
      {
        area: "Squadre",
        capabilities: [{ name: "Elenco", description: "Vede le squadre", endpoints: ["GET /teams"], evidence }],
      },
    ],
  },
  catalog: {
    tools: [
      toolProposal(),
      toolProposal({
        name: "create_team",
        description: "Crea una squadra",
        requiresConfirmation: true,
        readOnly: false,
        paramsSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        definition: { method: "POST", path: "/teams", paramLocations: { name: "body" } },
      }),
    ],
    endpoints: [
      {
        title: "Classifica",
        area: "Squadre",
        method: "get",
        path: "/standings",
        motivation: "Manca",
        patch: "router.get('/standings')",
        evidence,
      },
    ],
  },
  agents: {
    agents: [
      { role: "general", area: null, name: "Generale", systemPrompt: "Sei l'assistente.", defaultIdentity: "user", toolNames: [] },
      {
        role: "area",
        area: "Squadre",
        name: "Squadre",
        systemPrompt: "Gestisci le squadre.",
        defaultIdentity: "user",
        toolNames: ["list_teams", "create_team"],
      },
    ],
    skills: [
      {
        agentRole: "area",
        agentArea: "Squadre",
        name: "nuova_squadra",
        description: "Crea una squadra",
        instructions: "1. chiedi il nome 2. crea",
        toolNames: ["create_team"],
        paramsSchema: null,
      },
    ],
  },
  completion: {
    items: [
      {
        key: "standings",
        phase: 1,
        area: "Squadre",
        title: "Classifica",
        missing: "Pagina senza backend",
        evidence,
        goal: "Classifica",
        dependsOn: [],
        files: ["src/a.ts"],
        effort: "M",
        doneWhen: "La pagina mostra la classifica",
        implementation: "Aggiungere la route",
      },
    ],
  },
  evolution: {
    items: [
      {
        area: "Squadre",
        type: "funzione",
        title: "Export CSV",
        motivation: "Utile",
        evidence,
        benefit: "Report",
        impact: "medio",
        effort: "S",
        priority: 2,
        implementation: "Endpoint CSV",
      },
      {
        area: "Squadre",
        type: "agentica",
        title: "Promemoria",
        motivation: "Utile",
        evidence,
        benefit: "Meno dimenticanze",
        impact: "basso",
        effort: "S",
        priority: 4,
        implementation: "Skill",
      },
    ],
  },
};

const PHASE_BY_NUMBER: PhaseName[] = ["map", "capabilities", "catalog", "agents", "completion", "evolution"];

// --- Finto provider a copione: per ogni fase legge un file e poi consegna ---

let llm: http.Server;
/** Indirizzo compatibile OpenAI del finto modello. */
let llmBase: string;
let llmRequests: any[];
/** Header Authorization ricevuti dal finto provider, uno per richiesta. */
let llmAuth: (string | undefined)[];
let llmHangs: boolean;
/** Stato HTTP di errore con cui risponde il finto provider (null = risposta normale). */
let llmStatus: number | null;
/** Risposte 500 da dare prima di quelle normali. */
let llm500Remaining: number;
/** Richieste a cui il finto provider chiude la connessione senza rispondere. */
let llmDropRemaining: number;
/** Risposte 429 da dare prima di rispondere normalmente, con l'eventuale attesa suggerita. */
let llm429Remaining: number;
let llm429RetryAfter: string | null;
let llm429RetryDelay: string | null;
let llmPromptTokens: number;
/** Token di prompt riportati come letti dalla cache (0 = campo assente). */
let llmCachedTokens: number;
/** Fasi in cui il modello legge finché non riceve il sollecito del budget della fase. */
let readUntilNudge: Set<PhaseName>;
let invalidPhases: Set<PhaseName>;
let resultOverrides: Partial<Record<PhaseName, unknown>>;

function toolCall(name: string, args: Record<string, unknown>, id: string) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: {
      prompt_tokens: llmPromptTokens,
      completion_tokens: 20,
      ...(llmCachedTokens > 0 ? { prompt_tokens_details: { cached_tokens: llmCachedTokens } } : {}),
    },
  };
}

function phaseOf(body: any): PhaseName {
  const user = String(body.messages?.[1]?.content ?? "");
  const m = /FASE (\d)/.exec(user);
  return PHASE_BY_NUMBER[Number(m?.[1] ?? 1) - 1]!;
}

function scriptedReply(body: any) {
  const phase = phaseOf(body);
  const messages: any[] = body.messages ?? [];
  const toolMessages = messages.filter((m) => m.role === "tool").length;
  const last = messages.at(-1);
  const nudged = last?.role === "user" && String(last.content).startsWith("Budget della fase quasi esaurito");
  if (readUntilNudge.has(phase) && !nudged) return toolCall("read_file", { path: "src/a.ts" }, `read_${phase}_${messages.length}`);
  if (toolMessages === 0) return toolCall("read_file", { path: "src/a.ts" }, `read_${phase}`);
  if (invalidPhases.has(phase)) return toolCall("submit_result", { result: { items: "non valido" } }, `bad_${toolMessages}`);
  return toolCall("submit_result", { result: resultOverrides[phase] ?? RESULTS[phase] }, `submit_${phase}`);
}

// --- Finta app (OpenAPI) e finto GitHub ---

let appServer: http.Server;
let appBase: string;
let serveOpenApi: boolean;
let github: http.Server;
let githubBase: string;
let githubAuth: string[];

const OPENAPI_DOC = {
  openapi: "3.0.0",
  info: { title: "x", version: "1" },
  paths: { "/teams": { get: { operationId: "listTeams", summary: "Elenco" } } },
};

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function testZip(): Uint8Array {
  return zipSync({
    "progetto/src/a.ts": strToU8(`export const segreto = "${FILE_SECRET}";\n`),
    "progetto/README.md": strToU8("# Progetto\n"),
  });
}

let appId: number;
// Modello di base delle analisi: account `custom` verso il finto provider `llm` (prezzi non noti)
let baseModelId: number;

async function seedBaseModel(baseUrl: string): Promise<number> {
  const [user] = await db.insert(usersTable).values({ email: "base@example.com", name: "Base" }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId: user!.id,
      name: "Account di base",
      provider: "custom",
      baseUrl,
      allowPrivateNetwork: true,
      apiKeyEnc: encryptSecret("sk-test"),
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "openrouter/auto", displayName: "Base" })
    .returning();
  return model!.id;
}

async function createApp(over: Partial<typeof appsTable.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(appsTable)
    .values({ name: "Fanta", slug: `fanta-${Math.random().toString(36).slice(2, 8)}`, baseUrl: appBase, ...over })
    .returning();
  return row!.id;
}

async function createAnalysis(forApp = appId, over: Partial<typeof analysesTable.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(analysesTable)
    .values({
      appId: forApp,
      model: "openrouter/auto",
      aiModelId: baseModelId,
      sources: { code: "none", openapi: false, description: false },
      maxTokens: ANALYSIS_DEFAULT_MAX_TOKENS,
      ...over,
    })
    .returning();
  return row!.id;
}

const loadAnalysis = async (id: number) =>
  (await db.select().from(analysesTable).where(eq(analysesTable.id, id)))[0]!;
const loadItems = (id: number) =>
  db.select().from(analysisItemsTable).where(eq(analysisItemsTable.analysisId, id)).orderBy(asc(analysisItemsTable.position));

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  llmRequests = [];
  llmAuth = [];
  llmHangs = false;
  llmStatus = null;
  llm500Remaining = 0;
  llmDropRemaining = 0;
  llm429Remaining = 0;
  llm429RetryAfter = null;
  llm429RetryDelay = null;
  llmPromptTokens = 100;
  llmCachedTokens = 0;
  readUntilNudge = new Set();
  invalidPhases = new Set();
  resultOverrides = {};
  serveOpenApi = true;
  githubAuth = [];

  llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      llmRequests.push(body);
      llmAuth.push(req.headers.authorization);
      if (llmHangs) return;
      if (llmDropRemaining > 0) {
        llmDropRemaining -= 1;
        req.socket.destroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      if (llm429Remaining > 0) {
        llm429Remaining -= 1;
        res.statusCode = 429;
        if (llm429RetryAfter !== null) res.setHeader("retry-after", llm429RetryAfter);
        // Come Gemini: l'attesa suggerita nei dettagli dell'errore (RetryInfo.retryDelay)
        const details = llm429RetryDelay === null ? [] : [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: llm429RetryDelay }];
        res.end(JSON.stringify({ error: { code: 429, message: "quota exceeded", status: "RESOURCE_EXHAUSTED", details } }));
        return;
      }
      if (llmStatus !== null || llm500Remaining > 0) {
        res.statusCode = llmStatus ?? 500;
        if (llmStatus === null) llm500Remaining -= 1;
        // Il corpo dell'errore contiene un URL: non deve arrivare nell'errore salvato
        res.end(JSON.stringify({ error: { message: "upstream error, see https://openrouter.example/docs" } }));
        return;
      }
      res.end(JSON.stringify(scriptedReply(body)));
    });
  });
  appServer = http.createServer((req, res) => {
    if (serveOpenApi && req.url === "/openapi.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(OPENAPI_DOC));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  github = http.createServer((req, res) => {
    githubAuth.push(String(req.headers.authorization ?? ""));
    res.statusCode = 401;
    res.end(JSON.stringify({ message: "Bad credentials" }));
  });
  const llmPort = await listen(llm);
  appBase = `http://127.0.0.1:${await listen(appServer)}`;
  githubBase = `http://127.0.0.1:${await listen(github)}`;
  llmBase = `http://127.0.0.1:${llmPort}/v1`;
  process.env["CASELLO_SECRET_KEY"] = "b".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  baseModelId = await seedBaseModel(llmBase);
  appId = await createApp({ functionalDescription: "Gestione di squadre di fantacalcio" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of [llm, appServer, github]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
});

// Il finto provider ascolta su 127.0.0.1: deroga dei test al divieto del loopback (vedi allowTestLoopback)
let restoreLoopback: () => void;
beforeAll(() => {
  restoreLoopback = allowTestLoopback();
});
afterAll(() => restoreLoopback());

describe("startAnalysis", () => {
  it("esegue le sei fasi, salva mappa ed elementi con le differenze rispetto al DB", async () => {
    // Stato attuale dell'app: un tool identico alla proposta, uno non più proposto, l'agente generale
    await db.insert(appToolsTable).values([
      {
        appId,
        name: "list_teams",
        description: "Elenco squadre",
        kind: "http",
        identity: "user",
        requiresConfirmation: false,
        readOnly: true,
        paramsSchema: { type: "object", properties: { q: { type: "string" } } },
        definition: { method: "GET", path: "/teams", paramLocations: { q: "query" } },
        status: "active",
      },
      {
        appId,
        name: "old_tool",
        description: "Vecchio",
        kind: "http",
        identity: "user",
        requiresConfirmation: false,
        readOnly: true,
        paramsSchema: { type: "object", properties: {} },
        definition: { method: "GET", path: "/old", paramLocations: {} },
        status: "active",
      },
    ]);
    await db.insert(agentsTable).values({ appId, name: "Generale", role: "general", systemPrompt: "Altro prompt" });

    const id = await createAnalysis();
    await startAnalysis(id, { zip: testZip() });

    const a = await loadAnalysis(id);
    expect(a.error).toBeNull();
    expect(a.status).toBe("completed");
    expect(a.finishedAt).not.toBeNull();
    expect(a.sources).toEqual({ code: "zip", openapi: true, description: true });
    // La mappa calcolata da Casello si affianca all'esito della fase map
    expect(a.architectureMap).toEqual({ ...(RESULTS.map as object), repoMap: expect.stringContaining("src/") });
    // ...ed è nel messaggio utente di ogni fase
    expect(llmRequests.every((r) => String(r.messages[1].content).includes("Mappa del repository calcolata da Casello"))).toBe(true);
    // 12 chiamate da 120 token
    expect(a.tokensUsed).toBe(12 * 120);
    expect(llmRequests).toHaveLength(12);
    expect(llmRequests[0].model).toBe("openrouter/auto");

    const items = await loadItems(id);
    const byRef = Object.fromEntries(items.map((i) => [i.ref, i]));
    expect(items.map((i) => i.position)).toEqual(items.map((_, i) => i + 1));
    expect(new Set(items.map((i) => i.chapter))).toEqual(
      new Set(["tool", "endpoint", "agent", "skill", "completion", "evolution"]),
    );
    expect(byRef["tool:list_teams"]!.diff).toBe("unchanged");
    expect(byRef["tool:create_team"]!.diff).toBe("new");
    expect(byRef["tool:old_tool"]!.diff).toBe("removed");
    expect(byRef["endpoint:GET /standings"]!.diff).toBe("new");
    expect(byRef["endpoint:GET /standings"]!.chapter).toBe("endpoint");
    expect(byRef["agent:general"]!.diff).toBe("changed");
    expect(byRef["agent:area:Squadre"]!.diff).toBe("new");
    expect(byRef["skill:area:Squadre:nuova_squadra"]!.diff).toBe("new");
    expect(byRef["completion:standings"]!.chapter).toBe("completion");
    expect(byRef["evolution:1"]!.chapter).toBe("evolution");
    expect(byRef["evolution:2"]!.diff).toBe("new");
    expect(byRef["tool:create_team"]!.evidence).toEqual(evidence);
    expect(items.every((i) => i.status === "pending")).toBe(true);
    // Con codice e OpenAPI il needsVerification del modello resta com'è
    expect((byRef["tool:create_team"]!.payload as any).needsVerification).toBe(false);

    // Log: righe brevi degli strumenti, mai il contenuto dei file
    const log = a.log as AnalysisLogEntry[];
    expect(log.some((e) => e.phase === "map" && /read_file src\/a\.ts/.test(e.message))).toBe(true);
    expect(log.some((e) => e.phase === "evolution")).toBe(true);
    expect(JSON.stringify(log)).not.toContain(FILE_SECRET);
    // Il modello ha ricevuto il file (strumento di lettura funzionante)
    expect(JSON.stringify(llmRequests[1].messages)).toContain(FILE_SECRET);
  });

  it("seconda analisi dopo l'approvazione: il tool già creato risulta unchanged", async () => {
    const first = await createAnalysis();
    await startAnalysis(first, { zip: testZip() });
    expect((await loadItems(first)).find((i) => i.ref === "tool:list_teams")!.diff).toBe("new");
    // Il tool approvato ora esiste nel catalogo
    const t = toolProposal();
    await db.insert(appToolsTable).values({
      appId,
      name: t.name,
      description: t.description,
      kind: "http",
      identity: "user",
      requiresConfirmation: t.requiresConfirmation,
      readOnly: t.readOnly,
      paramsSchema: t.paramsSchema,
      definition: t.definition,
      status: "active",
    });
    const second = await createAnalysis();
    await startAnalysis(second, { zip: testZip() });
    expect((await loadItems(second)).find((i) => i.ref === "tool:list_teams")!.diff).toBe("unchanged");
  });

  it("le notes di una fase arrivano come appunti alle fasi successive e non negli esiti", async () => {
    resultOverrides.map = { ...(RESULTS.map as object), notes: "APPUNTO-MAP-XYZ" };
    const id = await createAnalysis();
    await startAnalysis(id, { zip: testZip() });

    expect((await loadAnalysis(id)).error).toBeNull();
    const caps = llmRequests.filter((r) => phaseOf(r) === "capabilities").map((r) => String(r.messages[1].content));
    expect(caps.length).toBeGreaterThan(0);
    for (const user of caps) {
      expect(user).toContain("Appunti delle fasi precedenti");
      expect(user).toContain("### map\nAPPUNTO-MAP-XYZ");
      expect(user.match(/APPUNTO-MAP-XYZ/g)).toHaveLength(1);
    }
  });

  it("fase completion non valida tre volte: failed, restano gli elementi di catalog e agents", async () => {
    invalidPhases.add("completion");
    const id = await createAnalysis();
    await startAnalysis(id, { zip: testZip() });

    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.finishedAt).not.toBeNull();
    expect(a.phase).toBe("completion");
    expect(a.error).toMatch(/completion/);
    expect(a.error).toMatch(/2 correzioni/);
    const chapters = new Set((await loadItems(id)).map((i) => i.chapter));
    expect(chapters).toEqual(new Set(["tool", "endpoint", "agent", "skill"]));
    // Nessuna chiamata dopo la fase fallita
    expect(llmRequests.some((r) => phaseOf(r) === "evolution")).toBe(false);
  });

  it("fase map non riuscita: architecture_map contiene comunque la mappa calcolata", async () => {
    invalidPhases.add("map");
    const id = await createAnalysis();
    await startAnalysis(id, { zip: testZip() });

    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.architectureMap).toEqual({ repoMap: expect.stringContaining("src/") });
    // Il contenuto del repository non finisce nel log
    expect(JSON.stringify(a.log)).not.toContain("Progetto");
  });

  it("GitHub 401: failed con un messaggio in italiano che non contiene il token", async () => {
    const ghApp = await createApp({
      sourceType: "github",
      sourceRepo: "ivan/fanta",
      sourceBranch: "main",
      sourceTokenEnc: encryptSecret(GITHUB_TOKEN),
    });
    const id = await createAnalysis(ghApp);
    await startAnalysis(id, { githubApiBase: githubBase });

    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toMatch(/token GitHub non valido/);
    // Il token è arrivato a GitHub (decifrato in memoria) ma non è finito da nessuna parte
    expect(githubAuth).toEqual([`Bearer ${GITHUB_TOKEN}`]);
    expect(JSON.stringify(a)).not.toContain(GITHUB_TOKEN);
    expect(llmRequests).toHaveLength(0);
    expect(await loadItems(id)).toHaveLength(0);
  });

  it("app con sorgente zip ma senza archivio: failed", async () => {
    const zipApp = await createApp({ sourceType: "zip" });
    const id = await createAnalysis(zipApp);
    await startAnalysis(id);
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toMatch(/zip/);
  });

  it("zip non valido: failed con il messaggio del sorgente", async () => {
    const id = await createAnalysis();
    await startAnalysis(id, { zip: strToU8("non sono uno zip") });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBeTruthy();
    expect(a.error).not.toMatch(/errore interno/i);
    expect(a.error).toMatch(/zip/i);
  });

  it("senza codice né OpenAPI le fasi girano sulla descrizione e i tool vanno verificati", async () => {
    serveOpenApi = false;
    const id = await createAnalysis();
    await startAnalysis(id);

    const a = await loadAnalysis(id);
    expect(a.status).toBe("completed");
    expect(a.sources).toEqual({ code: "none", openapi: false, description: true });
    const tools = (await loadItems(id)).filter((i) => i.chapter === "tool");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => (t.payload as any).needsVerification === true)).toBe(true);
    // Nessuno strumento di lettura offerto: solo submit_result
    expect(llmRequests[0].tools.map((t: any) => t.function.name)).toEqual(["submit_result"]);
  });

  it("la scadenza complessiva interrompe una chiamata al modello che non risponde, senza nuovi tentativi", async () => {
    llmHangs = true;
    const id = await createAnalysis();
    const started = Date.now();
    await startAnalysis(id, { zip: testZip(), maxMs: 400 });
    const elapsed = Date.now() - started;

    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toMatch(/tempo massimo dell'analisi \(0\.4 s\) scaduto durante la chiamata al modello/);
    expect(llmRequests).toHaveLength(1);
    // Interrotta dopo circa 1 s (minimo per chiamata), non dopo il timeout della chiamata
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  it("timeout della singola chiamata al modello: failed con il messaggio sul timeout, senza nuovi tentativi", async () => {
    llmHangs = true;
    const id = await createAnalysis();
    await startAnalysis(id, { zip: testZip(), modelTimeoutMs: 300 });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe(
      "fase map: errore nella chiamata al modello: il modello non ha risposto entro 0.3 s (riprova o scegli un modello più veloce)",
    );
    expect(a.error).not.toMatch(/http|127\.0\.0\.1/);
    expect(llmRequests).toHaveLength(1);
  }, 20_000);

  it("errore 500 transitorio: un nuovo tentativo e l'analisi prosegue", async () => {
    llm500Remaining = 1;
    const id = await createAnalysis();
    await startAnalysis(id, { zip: testZip(), transientRetryDelaysMs: [10, 10] });
    const a = await loadAnalysis(id);
    expect(a.error).toBeNull();
    expect(a.status).toBe("completed");
    expect(llmRequests).toHaveLength(13);
    expect((a.log ?? []).map((e) => e.message)).toContain("provider non raggiungibile (HTTP 500): nuovo tentativo tra 1 s (1 di 2)");
  });

  it("errore di connessione (non timeout): un nuovo tentativo e l'analisi prosegue", async () => {
    llmDropRemaining = 1;
    const id = await createAnalysis();
    await startAnalysis(id, { zip: testZip(), transientRetryDelaysMs: [10, 10] });
    const a = await loadAnalysis(id);
    expect(a.error).toBeNull();
    expect(a.status).toBe("completed");
    expect(llmRequests).toHaveLength(13);
    expect((a.log ?? []).map((e) => e.message)).toContain("provider non raggiungibile (errore di rete): nuovo tentativo tra 1 s (1 di 2)");
  });

  it("errore di connessione ripetuto: tutti i nuovi tentativi, poi 'provider non raggiungibile'", async () => {
    llmDropRemaining = 5;
    const id = await createAnalysis();
    await startAnalysis(id, { zip: testZip(), transientRetryDelaysMs: [10, 10] });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe("fase map: errore nella chiamata al modello: provider non raggiungibile");
    expect(llmRequests).toHaveLength(3);
  });

  it("attesa del nuovo tentativo oltre la scadenza dell'analisi: nessun nuovo tentativo", async () => {
    llmDropRemaining = 5;
    const id = await createAnalysis();
    const started = Date.now();
    await startAnalysis(id, { zip: testZip(), maxMs: 2_000, transientRetryDelaysMs: [60_000] });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe("fase map: errore nella chiamata al modello: provider non raggiungibile");
    expect(llmRequests).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it("ogni fase riceve la sua quota (share × maxTokens): il sollecito arriva all'80% della quota", async () => {
    // 5 000 token per chiamata, tetto 100 000: map ha 10 000 (sollecito a 8 000, dopo 2 chiamate),
    // capabilities ne ha 13 000 (sollecito a 10 400, dopo 3 chiamate); con quote uguali (1/6 → 16 667,
    // sollecito a 13 333) map ne farebbe 4
    llmPromptTokens = 4_980;
    readUntilNudge = new Set(["map", "capabilities"]);
    const id = await createAnalysis(appId, { maxTokens: 100_000 });
    await startAnalysis(id, { zip: testZip() });
    const a = await loadAnalysis(id);
    expect(a.error).toBeNull();
    expect(a.status).toBe("completed");
    const perPhase = (p: PhaseName) => llmRequests.filter((r) => phaseOf(r) === p).length;
    expect(perPhase("map")).toBe(3);
    expect(perPhase("capabilities")).toBe(4);
    expect(perPhase("catalog")).toBe(2);
    // le quote non usate passano alle fasi successive: il tetto vero resta il totale
    expect(a.tokensUsed).toBe((3 + 4 + 4 * 2) * 5_000);
  });

  it("analisi non in coda: nessun effetto", async () => {
    const id = await createAnalysis(appId, { status: "completed" });
    await startAnalysis(id, { zip: testZip() });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("completed");
    expect(llmRequests).toHaveLength(0);
    // Analisi inesistente: nessuna eccezione
    await expect(startAnalysis(99_999)).resolves.toBeUndefined();
  });
});

describe("startAnalysis sugli account AI", () => {
  const ACCOUNT_KEY = "sk-CHIAVE-ACCOUNT-ARCHITETTO-99";

  /** Account `custom` verso il finto provider, con un modello ai prezzi dati (USD per Mtok). */
  async function ownModel(prices: { input: string | null; output: string | null } = { input: "1", output: "2" }) {
    const [user] = await db.insert(usersTable).values({ email: "a@example.com", name: "A" }).returning();
    const [account] = await db
      .insert(aiAccountsTable)
      .values({
        userId: user!.id,
        name: "Account",
        provider: "custom",
        baseUrl: llmBase,
        allowPrivateNetwork: true,
        apiKeyEnc: encryptSecret(ACCOUNT_KEY),
        status: "ok",
      })
      .returning();
    const [model] = await db
      .insert(aiModelsTable)
      .values({ accountId: account!.id, modelId: "modello-architetto", displayName: "M", priceInputPerMtok: prices.input, priceOutputPerMtok: prices.output })
      .returning();
    return model!;
  }

  it("modello proprio: completata, chiave dell'account, costo sommato", async () => {
    const model = await ownModel();
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    await startAnalysis(id, { zip: testZip() });

    const a = await loadAnalysis(id);
    expect(a.error).toBeNull();
    expect(a.status).toBe("completed");
    expect(a.tokensUsed).toBe(12 * 120);
    // 12 × (100 × 1 + 20 × 2) / 1e6
    expect(Number(a.costUsd)).toBeCloseTo(0.00168, 8);
    expect(llmRequests[0].model).toBe("modello-architetto");
    expect(llmAuth.every((h) => h === `Bearer ${ACCOUNT_KEY}`)).toBe(true);
  });

  it("token in cache: pesati al 10% nel budget, salvati a parte e pagati al prezzo di cache", async () => {
    const model = await ownModel();
    await db.update(aiModelsTable).set({ priceCachedInputPerMtok: "0.1" }).where(eq(aiModelsTable.id, model.id));
    llmCachedTokens = 53;
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    await startAnalysis(id, { zip: testZip() });

    const a = await loadAnalysis(id);
    expect(a.status).toBe("completed");
    // 12 × (47 + 20 + 5,3) = 867,6 → arrotondato
    expect(a.tokensUsed).toBe(868);
    expect(a.cachedTokens).toBe(12 * 53);
    // 12 × (53 × 0,1 + 47 × 1 + 20 × 2) / 1e6 = 0,0011076 (la colonna tiene 6 decimali); a prezzo pieno 0,00168
    expect(a.costUsd).toBe("0.001108");
  });

  it("prezzi non noti: completata con cost_usd null", async () => {
    const model = await ownModel({ input: null, output: "2" });
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    await startAnalysis(id, { zip: testZip() });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("completed");
    expect(a.costUsd).toBeNull();
  });

  it("analisi cloud senza modello (aiModelId null): failed con 'scegli un modello', nessuna chiamata", async () => {
    const id = await createAnalysis(appId, { aiModelId: null });
    await startAnalysis(id, { zip: testZip() });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe("scegli un modello");
    expect(llmRequests).toHaveLength(0);
  });

  it.each([
    [402, "credito del provider esaurito: ricarica il conto o scegli un altro modello"],
    [400, "richiesta rifiutata dal provider (HTTP 400)"],
    [401, "chiave non valida o senza permessi"],
  ])("provider con errore %i: failed col messaggio fisso, senza nuovi tentativi né chiave", async (status, message) => {
    llmStatus = status;
    const model = await ownModel();
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    await startAnalysis(id, { zip: testZip() });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe(`fase map: errore nella chiamata al modello: ${message}`);
    expect(a.error).not.toContain(ACCOUNT_KEY);
    expect(a.error).not.toMatch(/http:|openrouter\.example/);
    expect(llmRequests).toHaveLength(1);
  });

  it("errori 5xx ripetuti ma transitori (Gemini sovraccarico): attese crescenti e l'analisi prosegue", async () => {
    llm500Remaining = 3;
    const model = await ownModel();
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    await startAnalysis(id, { zip: testZip(), transientRetryDelaysMs: [10, 10, 10, 10] });
    const a = await loadAnalysis(id);
    expect(a.error).toBeNull();
    expect(a.status).toBe("completed");
    expect(llmRequests).toHaveLength(15);
    const messages = (a.log ?? []).map((e) => e.message);
    expect(messages).toContain("provider non raggiungibile (HTTP 500): nuovo tentativo tra 1 s (1 di 4)");
    expect(messages).toContain("provider non raggiungibile (HTTP 500): nuovo tentativo tra 1 s (3 di 4)");
  });

  it("errore 5xx persistente: dopo i nuovi tentativi failed col messaggio fisso", async () => {
    llmStatus = 503;
    const model = await ownModel();
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    await startAnalysis(id, { zip: testZip(), transientRetryDelaysMs: [10, 10, 10] });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe("fase map: errore nella chiamata al modello: provider non raggiungibile");
    expect(llmRequests).toHaveLength(4);
  });

  it("i tentativi sui 5xx sono indipendenti da quelli sul 429", async () => {
    llm500Remaining = 1;
    llm429Remaining = 1;
    const model = await ownModel();
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    await startAnalysis(id, { zip: testZip(), transientRetryDelaysMs: [10], rateLimitDelaysMs: [10] });
    const a = await loadAnalysis(id);
    expect(a.error).toBeNull();
    expect(a.status).toBe("completed");
  });

  it("limite di richieste transitorio (429): attesa, nuovi tentativi e l'analisi prosegue", async () => {
    llm429Remaining = 2;
    const model = await ownModel();
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    await startAnalysis(id, { zip: testZip(), rateLimitDelaysMs: [10, 10, 10, 10, 10] });
    const a = await loadAnalysis(id);
    expect(a.error).toBeNull();
    expect(a.status).toBe("completed");
    expect(llmRequests).toHaveLength(14);
    const messages = (a.log ?? []).map((e) => e.message);
    expect(messages).toContain("limite di richieste del provider: nuovo tentativo tra 1 s (1 di 5)");
    expect(messages).toContain("limite di richieste del provider: nuovo tentativo tra 1 s (2 di 5)");
  });

  it("429 con l'attesa suggerita da Gemini (retryDelay): si aspetta quella, non la pausa predefinita", async () => {
    llm429Remaining = 1;
    llm429RetryDelay = "0.2s";
    const model = await ownModel();
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    const started = Date.now();
    await startAnalysis(id, { zip: testZip(), rateLimitDelaysMs: [60_000] });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("completed");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((a.log ?? []).map((e) => e.message)).toContain("limite di richieste del provider: nuovo tentativo tra 1 s (1 di 1)");
  }, 20_000);

  it("429 con Retry-After: si aspetta quanto indica il provider", async () => {
    llm429Remaining = 1;
    llm429RetryAfter = "1";
    const model = await ownModel();
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    const started = Date.now();
    await startAnalysis(id, { zip: testZip(), rateLimitDelaysMs: [60_000] });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("completed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("limite di richieste persistente: dopo i nuovi tentativi failed col messaggio fisso", async () => {
    llmStatus = 429;
    const model = await ownModel();
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    await startAnalysis(id, { zip: testZip(), rateLimitDelaysMs: [10, 10, 10] });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe("fase map: errore nella chiamata al modello: limite di richieste del provider: riprova più tardi");
    expect(a.error).not.toContain(ACCOUNT_KEY);
    expect(llmRequests).toHaveLength(4);
  });

  it("attesa per il 429 oltre la scadenza dell'analisi: nessun nuovo tentativo", async () => {
    llm429Remaining = 5;
    const model = await ownModel();
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    const started = Date.now();
    await startAnalysis(id, { zip: testZip(), maxMs: 2_000, rateLimitDelaysMs: [60_000] });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe("fase map: errore nella chiamata al modello: limite di richieste del provider: riprova più tardi");
    expect(llmRequests).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it("timeout della singola chiamata: messaggio sul timeout, senza nuovi tentativi", async () => {
    llmHangs = true;
    const model = await ownModel();
    const id = await createAnalysis(appId, { aiModelId: model.id, model: "modello-architetto" });
    await startAnalysis(id, { zip: testZip(), modelTimeoutMs: 300 });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe(
      "fase map: errore nella chiamata al modello: il modello non ha risposto entro 0.3 s (riprova o scegli un modello più veloce)",
    );
    expect(llmRequests).toHaveLength(1);
  }, 20_000);

  it("modello del vecchio account del gateway rimasto nel DB: failed con 'modello non disponibile'", async () => {
    await ensureLegacyGatewayProvider();
    const [account] = await db
      .insert(aiAccountsTable)
      .values({ userId: null, name: "Gateway Casello", provider: LEGACY_GATEWAY_PROVIDER, baseUrl: llmBase, status: "ok" })
      .returning();
    const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "openrouter/auto", displayName: "Auto" }).returning();
    const id = await createAnalysis(appId, { aiModelId: model!.id });
    await startAnalysis(id, { zip: testZip() });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe("modello non disponibile");
    expect(llmRequests).toHaveLength(0);
  });
});

describe("startAnalysis con l'installazione della GitHub App", () => {
  const NO_ACCESS = "l'App Casello non ha più accesso a questo repository: reinstallala o scegli un altro repo";
  let gh: FakeGithub;
  let cfg: GithubConfig;

  beforeAll(async () => {
    gh = await startFakeGithub();
    cfg = {
      appId: gh.appId,
      slug: gh.slug,
      clientId: gh.clientId,
      clientSecret: gh.clientSecret,
      privateKey: gh.privateKeyPem,
      apiBase: gh.apiBase,
      webBase: gh.webBase,
    };
  });

  afterAll(async () => {
    await gh.close();
  });

  beforeEach(() => {
    clearInstallationTokenCache();
    gh.installations.clear();
    gh.repos.clear();
    gh.revoked.clear();
    gh.issuedTokens.clear();
    gh.requests.length = 0;
    gh.failWith = null;
    gh.addInstallation({ id: 11, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" }, [
      { fullName: "ivan/fanta", defaultBranch: "main", private: true },
      { fullName: "ivan/altro", defaultBranch: "main", private: true },
    ]);
    gh.zipballs.set("ivan/fanta", testZip());
  });

  const installationApp = () =>
    createApp({ sourceType: "github", sourceRepo: "ivan/fanta", sourceBranch: "main", sourceInstallationId: 11, functionalDescription: "Squadre" });

  /** Token di installazione emessi dal finto GitHub: non devono comparire nell'analisi salvata. */
  const issued = () => [...gh.issuedTokens.keys()];

  it("token ristretto al repo sul download; log senza token", async () => {
    const id = await createAnalysis(await installationApp());
    await startAnalysis(id, { githubConfig: cfg });

    const a = await loadAnalysis(id);
    expect(a.error).toBeNull();
    expect(a.status).toBe("completed");
    expect(a.sources).toMatchObject({ code: "github" });

    const tokenReq = gh.requests.filter((r) => r.path === "/app/installations/11/access_tokens");
    expect(tokenReq).toHaveLength(1);
    expect(tokenReq[0]!.body).toEqual({ repositories: ["fanta"], permissions: { contents: "read" } });
    const [token] = issued();
    expect(gh.issuedTokens.get(token!)).toMatchObject({ installationId: 11, repositories: ["ivan/fanta"], permissions: { contents: "read" } });
    const zipball = gh.requests.find((r) => r.path.startsWith("/repos/ivan/fanta/zipball"));
    expect(zipball?.path).toBe("/repos/ivan/fanta/zipball/main");
    expect(zipball?.auth).toBe(`Bearer ${token}`);

    const log = a.log as AnalysisLogEntry[];
    expect(log.some((e) => e.message === "codice: GitHub ivan/fanta tramite l'App (2 file)")).toBe(true);
    expect(JSON.stringify(a)).not.toContain(token!);
    expect(JSON.stringify(a)).not.toContain("ghs_");
  });

  it("installazione revocata: failed con il messaggio della spec, senza token", async () => {
    gh.revoked.add(11);
    const id = await createAnalysis(await installationApp());
    await startAnalysis(id, { githubConfig: cfg });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe(NO_ACCESS);
    expect(JSON.stringify(a)).not.toContain("ghs_");
    expect(llmRequests).toHaveLength(0);
  });

  it("branch inesistente: failed con il messaggio sul branch, il token in cache resta", async () => {
    const wrong = await createApp({ sourceType: "github", sourceRepo: "ivan/fanta", sourceBranch: "nope", sourceInstallationId: 11, functionalDescription: "Squadre" });
    const id = await createAnalysis(wrong);
    await startAnalysis(id, { githubConfig: cfg });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe("repository o branch non trovato: controlla il branch nelle sorgenti dell'app");
    expect(gh.requests.find((r) => r.path.startsWith("/repos/ivan/fanta/zipball"))?.path).toBe("/repos/ivan/fanta/zipball/nope");
    for (const t of issued()) expect(JSON.stringify(a)).not.toContain(t);

    // Token non scartato: l'analisi sul branch giusto riusa quello in cache
    const id2 = await createAnalysis(await installationApp());
    await startAnalysis(id2, { githubConfig: cfg });
    expect((await loadAnalysis(id2)).status).toBe("completed");
    expect(gh.requests.filter((r) => r.path === "/app/installations/11/access_tokens")).toHaveLength(1);
  });

  it("revocata dopo il token in cache: il download risponde 401 → messaggio della spec e cache svuotata", async () => {
    const appWithInst = await installationApp();
    const first = await createAnalysis(appWithInst);
    await startAnalysis(first, { githubConfig: cfg });
    expect((await loadAnalysis(first)).status).toBe("completed");

    gh.revoked.add(11);
    const second = await createAnalysis(appWithInst);
    await startAnalysis(second, { githubConfig: cfg });
    const a = await loadAnalysis(second);
    expect(a.status).toBe("failed");
    expect(a.error).toBe(NO_ACCESS);
    for (const t of issued()) expect(JSON.stringify(a)).not.toContain(t);

    // Il token scartato non si riusa: la prossima analisi ne chiede uno nuovo
    gh.revoked.delete(11);
    gh.requests.length = 0;
    const third = await createAnalysis(appWithInst);
    await startAnalysis(third, { githubConfig: cfg });
    expect((await loadAnalysis(third)).status).toBe("completed");
    expect(gh.requests.filter((r) => r.path === "/app/installations/11/access_tokens")).toHaveLength(1);
  });

  it("GitHub non risponde sul token: failed con il testo fisso", async () => {
    gh.failWith = (r) => (r.path.includes("/access_tokens") ? 503 : null);
    const id = await createAnalysis(await installationApp());
    await startAnalysis(id, { githubConfig: cfg });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe("GitHub non risponde (riprova più tardi)");
  });

  it("GitHub non configurato e app con installazione: failed 'GitHub non configurato'", async () => {
    const id = await createAnalysis(await installationApp());
    await startAnalysis(id, { githubConfig: null });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toBe("GitHub non configurato");
    expect(gh.requests).toHaveLength(0);
  });

  it("GitHub non configurato e app senza installazione: token manuale come nella fase 3", async () => {
    const manual = await createApp({
      sourceType: "github",
      sourceRepo: "ivan/fanta",
      sourceBranch: "main",
      sourceTokenEnc: encryptSecret(GITHUB_TOKEN),
    });
    const id = await createAnalysis(manual);
    await startAnalysis(id, { githubApiBase: githubBase, githubConfig: null });
    const a = await loadAnalysis(id);
    expect(a.status).toBe("failed");
    expect(a.error).toMatch(/token GitHub non valido/);
    expect(githubAuth).toEqual([`Bearer ${GITHUB_TOKEN}`]);
    expect(gh.requests).toHaveLength(0);
  });
});

describe("failInterruptedAnalyses", () => {
  it("chiude come interrupted le analisi queued e running", async () => {
    const running = await createAnalysis(appId, { status: "running" });
    const otherApp = await createApp();
    const queued = await createAnalysis(otherApp);
    const done = await createAnalysis(appId, { status: "completed" });

    expect(await failInterruptedAnalyses()).toBe(2);
    for (const id of [running, queued]) {
      const a = await loadAnalysis(id);
      expect(a.status).toBe("interrupted");
      expect(a.finishedAt).not.toBeNull();
      expect(a.error).toMatch(/riavvio/);
    }
    expect((await loadAnalysis(done)).status).toBe("completed");
  });
});

describe("appendLog", () => {
  it(`tiene al massimo ${ANALYSIS_LOG_MAX} voci, le più recenti`, () => {
    const entry = (n: number): AnalysisLogEntry => ({ at: "t", phase: "map", message: `m${n}` });
    let log: AnalysisLogEntry[] = [];
    log = appendLog(log, Array.from({ length: 300 }, (_, i) => entry(i)));
    log = appendLog(log, Array.from({ length: 300 }, (_, i) => entry(300 + i)));
    expect(log).toHaveLength(ANALYSIS_LOG_MAX);
    expect(log[0]!.message).toBe("m100");
    expect(log.at(-1)!.message).toBe("m599");
  });

  it("costanti", () => {
    expect(ANALYSIS_DEFAULT_MAX_TOKENS).toBe(1_000_000);
    expect(ANALYSIS_MAX_MS).toBe(1_800_000);
  });
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import {
  db,
  pool,
  agentSkillsTable,
  agentsTable,
  analysesTable,
  analysisItemsTable,
  appToolsTable,
  type AnalysisItem,
} from "@workspace/db";
import { decryptSecret } from "../lib/secrets";

// Route dell'architetto su un'app Express vera (porta 0), senza login (AUTH_DISABLED=true).
// Il finto LiteLLM trattiene le richieste: le analisi avviate restano in corso finché il test non
// le chiude (afterEach risponde con un errore e attende che nessuna analisi resti attiva), così
// nulla gira in background oltre il test.

const GITHUB_TOKEN = "ghp_TOKENSEGRETISSIMO0123456789";

let base: string;
let server: http.Server;
let llm: http.Server;
let fakeApp: http.Server;
let fakeAppBase: string;
let llmMode: "hold" | "fail";
let held: http.ServerResponse[] = [];
let llmRequests: number;

const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY", "AI_GATEWAY_BASE_URL", "AI_GATEWAY_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

function close(s: http.Server): Promise<void> {
  return new Promise((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  });
}

function failLlm(res: http.ServerResponse) {
  res.statusCode = 400;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: { message: "rifiutato dal test" } }));
}

async function api(method: string, path: string, body?: unknown, root = base) {
  const res = await fetch(`${root}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function postZip(path: string, body: Uint8Array, root = base) {
  const res = await fetch(`${root}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json: json as { error?: string; [k: string]: unknown } | undefined };
}

async function createApp(extra: Record<string, unknown> = {}) {
  const res = await api("POST", "/apps", { name: "Mister", baseUrl: fakeAppBase, ...extra });
  expect(res.status, res.text).toBe(201);
  return res.json as { id: number; sourceTokenSet: boolean };
}

async function generalAgentOf(appId: number) {
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.appId, appId));
  return agent!;
}

/** Attende che nessuna analisi resti queued/running, dopo aver fatto fallire le chiamate al modello. */
async function settleAnalyses() {
  llmMode = "fail";
  for (const res of held.splice(0)) failLlm(res);
  for (let i = 0; i < 500; i++) {
    const active = await db
      .select({ id: analysesTable.id })
      .from(analysesTable)
      .where(inArray(analysesTable.status, ["queued", "running"]));
    if (!active.length) return;
    for (const res of held.splice(0)) failLlm(res);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("analisi ancora attive dopo il test");
}

async function waitForLlmRequest() {
  for (let i = 0; i < 500; i++) {
    if (llmRequests > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("nessuna chiamata al modello");
}

// --- Elementi di prova ---

const evidence = [{ source: "code", location: "src/a.ts:1" }];

const toolPayload = (over: Record<string, unknown> = {}) => ({
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

const completionPayload = (key: string, title: string, phase: number, dependsOn: string[] = []) => ({
  key,
  phase,
  area: "Squadre",
  title,
  missing: "Manca",
  evidence,
  goal: "Obiettivo",
  dependsOn,
  files: ["src/a.ts"],
  effort: "S",
  doneWhen: "Funziona",
  implementation: "Implementare",
});

const skillPayload = {
  agentRole: "general",
  agentArea: null,
  name: "consulta_squadre",
  description: "Consulta le squadre",
  instructions: "Usa list_teams",
  toolNames: ["list_teams"],
  paramsSchema: null,
};

let seq = 0;

async function newAnalysis(appId: number, status: "completed" | "running" = "completed") {
  const [row] = await db
    .insert(analysesTable)
    .values({ appId, model: "openrouter/auto", status, sources: { code: "none", openapi: false, description: true }, maxTokens: 400_000 })
    .returning();
  return row!.id;
}

async function addItem(
  analysisId: number,
  chapter: AnalysisItem["chapter"],
  payload: unknown,
  over: Partial<{ diff: AnalysisItem["diff"]; position: number; ref: string }> = {},
): Promise<AnalysisItem> {
  seq += 1;
  const [row] = await db
    .insert(analysisItemsTable)
    .values({
      analysisId,
      chapter,
      ref: over.ref ?? `${chapter}:${seq}`,
      position: over.position ?? seq,
      payload,
      diff: over.diff ?? "new",
      evidence,
    })
    .returning();
  return row!;
}

async function itemRow(id: number) {
  const [row] = await db.select().from(analysisItemsTable).where(eq(analysisItemsTable.id, id));
  return row!;
}

let createAnalysesRouter: (opts?: { zipLimitBytes?: number }) => express.Router;
let errorHandler: express.ErrorRequestHandler;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "c".repeat(64);
  process.env["AI_GATEWAY_API_KEY"] = "sk-test";

  llm = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      llmRequests++;
      if (llmMode === "hold") held.push(res);
      else failLlm(res);
    });
  });
  // Finta app: nessuna OpenAPI (404 a ogni richiesta)
  fakeApp = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.statusCode = 404;
      res.end();
    });
  });
  process.env["AI_GATEWAY_BASE_URL"] = `http://127.0.0.1:${await listen(llm)}/v1`;
  fakeAppBase = `http://127.0.0.1:${await listen(fakeApp)}`;

  const { default: app } = await import("../app");
  ({ createAnalysesRouter } = await import("./analyses"));
  ({ errorHandler } = await import("../middlewares/error-handler"));
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  await settleAnalyses();
  await close(server);
  await close(llm);
  await close(fakeApp);
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  llmMode = "hold";
  held = [];
  llmRequests = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

afterEach(async () => {
  await settleAnalyses();
});

describe("sorgenti dell'app", () => {
  it("GET /apps/:id espone sourceTokenSet e mai il token; '' lo lascia, null lo cancella", async () => {
    const created = await createApp({ sourceType: "github", sourceRepo: "ivan/mister", sourceToken: GITHUB_TOKEN });
    expect(created.sourceTokenSet).toBe(true);

    let res = await api("GET", `/apps/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ sourceType: "github", sourceRepo: "ivan/mister", sourceTokenSet: true });
    expect(res.json).not.toHaveProperty("sourceToken");
    expect(res.json).not.toHaveProperty("sourceTokenEnc");
    expect(res.text).not.toContain(GITHUB_TOKEN);
    expect((await api("GET", "/apps")).text).not.toContain(GITHUB_TOKEN);

    const { rows } = await pool.query("select source_token_enc from apps where id = $1", [created.id]);
    expect(rows[0].source_token_enc).toMatch(/^v1:/);
    expect(rows[0].source_token_enc).not.toContain(GITHUB_TOKEN);

    res = await api("PATCH", `/apps/${created.id}`, { sourceToken: "" });
    expect(res.json.sourceTokenSet).toBe(true);
    res = await api("PATCH", `/apps/${created.id}`, { sourceToken: null });
    expect(res.json.sourceTokenSet).toBe(false);
    res = await api("PATCH", `/apps/${created.id}`, { sourceToken: "nuovo" });
    expect(res.json.sourceTokenSet).toBe(true);

    const empty = await createApp({ sourceToken: "" });
    expect(empty.sourceTokenSet).toBe(false);
  });

  it("il token GitHub si salva senza spazi ai bordi; solo spazi lo lascia invariato", async () => {
    const storedToken = async (id: number) => {
      const { rows } = await pool.query("select source_token_enc from apps where id = $1", [id]);
      return rows[0].source_token_enc === null ? null : decryptSecret(rows[0].source_token_enc as string);
    };
    const created = await createApp({ sourceType: "github", sourceRepo: "ivan/mister", sourceToken: `${GITHUB_TOKEN}\n` });
    expect(await storedToken(created.id)).toBe(GITHUB_TOKEN);

    let res = await api("PATCH", `/apps/${created.id}`, { sourceToken: "  nuovo-token \r\n" });
    expect(res.status).toBe(200);
    expect(await storedToken(created.id)).toBe("nuovo-token");

    res = await api("PATCH", `/apps/${created.id}`, { sourceToken: " \n " });
    expect(res.json.sourceTokenSet).toBe(true);
    expect(await storedToken(created.id)).toBe("nuovo-token");

    const blank = await createApp({ sourceToken: "\n" });
    expect(blank.sourceTokenSet).toBe(false);
  });

  it("repo, tipo di sorgente, openapiUrl e descrizione validati → 400 in italiano", async () => {
    for (const repo of ["mister", "../mister", "ivan/..", "./x", "ivan/mi ster", "a/b/c"]) {
      const res = await api("POST", "/apps", { name: "Mister", baseUrl: fakeAppBase, sourceType: "github", sourceRepo: repo });
      expect(res.status, repo).toBe(400);
      expect(res.json.error, repo).toMatch(/^sourceRepo: /);
    }
    const noRepo = await api("POST", "/apps", { name: "Mister", baseUrl: fakeAppBase, sourceType: "github" });
    expect(noRepo.status).toBe(400);
    expect(noRepo.json.error).toMatch(/^sourceRepo: /);

    for (const url of ["ftp://x.example/openapi.json", "javascript:alert(1)", "non un url"]) {
      const res = await api("POST", "/apps", { name: "Mister", baseUrl: fakeAppBase, openapiUrl: url });
      expect(res.status, url).toBe(400);
      expect(res.json.error, url).toMatch(/^openapiUrl: /);
    }
    const long = await api("POST", "/apps", { name: "Mister", baseUrl: fakeAppBase, functionalDescription: "x".repeat(20_001) });
    expect(long.status).toBe(400);
    expect(long.json.error).toMatch(/^functionalDescription: /);
    expect((await api("GET", "/apps")).json).toEqual([]);

    // PATCH: la coerenza si valuta sullo stato risultante
    const app = await createApp({ openapiUrl: "https://mister.example/openapi.json", functionalDescription: "x".repeat(20_000) });
    let res = await api("PATCH", `/apps/${app.id}`, { sourceType: "github" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/^sourceRepo: /);
    res = await api("PATCH", `/apps/${app.id}`, { sourceType: "github", sourceRepo: "ivan/mister" });
    expect(res.status).toBe(200);
    res = await api("PATCH", `/apps/${app.id}`, { sourceRepo: null });
    expect(res.status).toBe(400);
    res = await api("PATCH", `/apps/${app.id}`, { sourceType: "zip", sourceRepo: null });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ sourceType: "zip", sourceRepo: null });
  });
});

describe("avvio dell'analisi", () => {
  it("modello non in elenco → 400 e nessuna analisi", async () => {
    const app = await createApp();
    const res = await api("POST", `/apps/${app.id}/analyses`, { model: "gpt-4o" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/modello/i);
    expect(await db.select().from(analysesTable)).toHaveLength(0);
  });

  it("app inesistente → 404; sorgente zip → 400; github senza token → 400", async () => {
    expect((await api("POST", "/apps/999/analyses", { model: "openrouter/auto" })).status).toBe(404);

    const zipApp = await createApp({ sourceType: "zip" });
    const zip = await api("POST", `/apps/${zipApp.id}/analyses`, { model: "openrouter/auto" });
    expect(zip.status).toBe(400);
    expect(zip.json.error).toMatch(/usa il caricamento dello zip/);

    const gh = await createApp({ sourceType: "github", sourceRepo: "ivan/mister" });
    const res = await api("POST", `/apps/${gh.id}/analyses`, { model: "openrouter/auto" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/token GitHub/);
    expect(await db.select().from(analysesTable)).toHaveLength(0);
  });

  it("avvio → 202 queued con il tetto di default; secondo avvio mentre è in corso → 409", async () => {
    const app = await createApp({ functionalDescription: "Gestione squadre" });
    const first = await api("POST", `/apps/${app.id}/analyses`, { model: "openrouter/deepseek-chat" });
    expect(first.status, first.text).toBe(202);
    expect(first.json).toMatchObject({
      appId: app.id,
      model: "openrouter/deepseek-chat",
      status: "queued",
      maxTokens: 1_000_000,
      tokensUsed: 0,
      sources: { code: "none", description: true },
    });
    await waitForLlmRequest(); // l'analisi è partita davvero ed è ferma sulla chiamata al modello

    const second = await api("POST", `/apps/${app.id}/analyses`, { model: "openrouter/auto", maxTokens: 50_000 });
    expect(second.status).toBe(409);
    expect(second.json.error).toMatch(/in corso/);

    const list = await api("GET", `/apps/${app.id}/analyses`);
    expect(list.status).toBe(200);
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ id: first.json.id, status: "running" });
    expect(list.json[0]).not.toHaveProperty("log");

    await settleAnalyses();
    const [row] = await db.select().from(analysesTable).where(eq(analysesTable.id, first.json.id));
    expect(row!.status).toBe("failed");
    expect((await api("GET", "/apps/999/analyses")).status).toBe(404);
  });

  it("zip vuoto → 400; zip valido → 202 con sorgente zip", async () => {
    const app = await createApp();
    const empty = await postZip(`/apps/${app.id}/analyses/zip?model=openrouter/auto`, new Uint8Array());
    expect(empty.status).toBe(400);
    expect(empty.json?.error).toMatch(/zip/);

    const zip = zipSync({ "src/a.ts": strToU8("export const a = 1;\n") });
    const ok = await postZip(`/apps/${app.id}/analyses/zip?model=openrouter/auto&maxTokens=60000`, zip);
    expect(ok.status, ok.text).toBe(202);
    expect(ok.json).toMatchObject({ status: "queued", maxTokens: 60_000, sources: { code: "zip" } });
  });

  it("zip oltre il limite (ridotto) → 413 JSON", async () => {
    const mini = express();
    mini.use(express.json());
    mini.use("/api", createAnalysesRouter({ zipLimitBytes: 1024 }));
    mini.use("/api", errorHandler);
    const miniServer = http.createServer(mini);
    const miniBase = `http://127.0.0.1:${await listen(miniServer)}`;
    try {
      const app = await createApp();
      const res = await postZip(`/apps/${app.id}/analyses/zip?model=openrouter/auto`, new Uint8Array(4096), miniBase);
      expect(res.status).toBe(413);
      expect(res.json).toEqual({ error: "archivio troppo grande" });
      expect(await db.select().from(analysesTable)).toHaveLength(0);
    } finally {
      await close(miniServer);
    }
  });
});

describe("dettaglio ed esportazione", () => {
  it("GET /analyses/:id: elementi per capitolo (ordine delle fasi) e posizione; 404", async () => {
    const app = await createApp();
    const analysisId = await newAnalysis(app.id);
    await addItem(analysisId, "evolution", { title: "e" }, { position: 1 });
    await addItem(analysisId, "skill", skillPayload, { position: 2 });
    await addItem(analysisId, "tool", toolPayload({ name: "b" }), { position: 4 });
    await addItem(analysisId, "endpoint", { title: "x" }, { position: 3 });
    await addItem(analysisId, "tool", toolPayload({ name: "a" }), { position: 3 });
    // prova senza nota: in uscita diventa una stringa vuota
    const res = await api("GET", `/analyses/${analysisId}`);
    expect(res.status, res.text).toBe(200);
    expect(res.json.items.map((i: { chapter: string; position: number }) => `${i.chapter}:${i.position}`)).toEqual([
      "tool:3",
      "tool:4",
      "endpoint:3",
      "skill:2",
      "evolution:1",
    ]);
    expect(res.json.items[0].evidence).toEqual([{ source: "code", location: "src/a.ts:1", note: "" }]);
    expect(res.json).toMatchObject({ log: [], architectureMap: null, status: "completed" });
    expect((await api("GET", "/analyses/999")).status).toBe(404);
  });

  it("export completion → markdown con i titoli in ordine (fase, poi dipendenze)", async () => {
    const app = await createApp();
    const analysisId = await newAnalysis(app.id);
    const items = [
      await addItem(analysisId, "completion", completionPayload("c", "Terzo passo", 2)),
      await addItem(analysisId, "completion", completionPayload("b", "Secondo passo", 1, ["a"])),
      await addItem(analysisId, "completion", completionPayload("a", "Primo passo", 1)),
      await addItem(analysisId, "completion", completionPayload("d", "Non approvato", 1)),
    ];
    await db
      .update(analysisItemsTable)
      .set({ status: "approved" })
      .where(inArray(analysisItemsTable.id, items.slice(0, 3).map((i) => i.id)));

    const res = await api("GET", `/analyses/${analysisId}/issues?chapter=completion`);
    expect(res.status, res.text).toBe(200);
    expect(res.json.count).toBe(3);
    const md: string = res.json.markdown;
    const order = ["## Fase 1", "### Primo passo", "### Secondo passo", "## Fase 2", "### Terzo passo"].map((t) => md.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).not.toContain("Non approvato");

    const pending = await api("GET", `/analyses/${analysisId}/issues?chapter=completion&status=pending`);
    expect(pending.json.count).toBe(1);
    expect(pending.json.markdown).toContain("Non approvato");

    expect((await api("GET", `/analyses/${analysisId}/issues?chapter=tool`)).status).toBe(400);
    expect((await api("GET", `/analyses/999/issues?chapter=completion`)).status).toBe(404);
  });
});

describe("revisione degli elementi", () => {
  it("approvazione di un tool valido → 200 e tool active nel catalogo", async () => {
    const app = await createApp();
    const analysisId = await newAnalysis(app.id);
    const item = await addItem(analysisId, "tool", toolPayload());

    const res = await api("PATCH", `/analysis-items/${item.id}`, { status: "approved", reviewNote: "ok" });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ id: item.id, status: "approved", reviewNote: "ok" });
    expect(res.json.appliedAt).not.toBeNull();

    const catalog = await api("GET", `/apps/${app.id}/tools`);
    expect(catalog.json).toHaveLength(1);
    expect(catalog.json[0]).toMatchObject({ name: "list_teams", status: "active" });

    // Un elemento approvato non cambia più
    const again = await api("PATCH", `/analysis-items/${item.id}`, { status: "discarded" });
    expect(again.status).toBe(409);
    expect((await api("PATCH", `/analysis-items/${item.id}`, { status: "approved" })).status).toBe(409);
    expect((await api("PATCH", "/analysis-items/999", { status: "approved" })).status).toBe(404);
  });

  it("approvazione non applicabile → 400 in italiano, elemento pending e nulla scritto", async () => {
    const app = await createApp();
    await db.insert(appToolsTable).values({
      appId: app.id,
      name: "list_teams",
      kind: "http",
      definition: { method: "GET", path: "/teams" },
      paramsSchema: { type: "object", properties: {} },
    });
    const analysisId = await newAnalysis(app.id);
    const item = await addItem(analysisId, "tool", toolPayload());
    const area = await addItem(analysisId, "agent", {
      role: "area",
      area: "Squadre",
      name: "Agente squadre",
      systemPrompt: "p",
      defaultIdentity: "user",
      toolNames: ["inesistente"],
    });

    const res = await api("PATCH", `/analysis-items/${item.id}`, { status: "approved", reviewNote: "provo" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/Esiste già uno strumento "list_teams"/);
    expect(await itemRow(item.id)).toMatchObject({ status: "pending", appliedAt: null, reviewNote: null });

    const agentRes = await api("PATCH", `/analysis-items/${area.id}`, { status: "approved" });
    expect(agentRes.status).toBe(400);
    expect(agentRes.json.error).toMatch(/inesistente/);
    expect((await itemRow(area.id)).status).toBe("pending");
    expect(await db.select().from(agentsTable).where(eq(agentsTable.appId, app.id))).toHaveLength(1);
  });

  it("doppia approvazione contemporanea → una 200, l'altra 409, un solo tool", async () => {
    const app = await createApp();
    const analysisId = await newAnalysis(app.id);
    const item = await addItem(analysisId, "tool", toolPayload());
    const results = await Promise.all([
      api("PATCH", `/analysis-items/${item.id}`, { status: "approved" }),
      api("PATCH", `/analysis-items/${item.id}`, { status: "approved" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.select().from(appToolsTable).where(eq(appToolsTable.appId, app.id))).toHaveLength(1);
  });

  it("postponed su un tool → 400; su completion → 200 e poi di nuovo pending o discarded", async () => {
    const app = await createApp();
    const analysisId = await newAnalysis(app.id);
    const tool = await addItem(analysisId, "tool", toolPayload());
    const res = await api("PATCH", `/analysis-items/${tool.id}`, { status: "postponed" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/rimand/);
    expect((await itemRow(tool.id)).status).toBe("pending");

    const comp = await addItem(analysisId, "completion", completionPayload("a", "Primo", 1));
    expect((await api("PATCH", `/analysis-items/${comp.id}`, { status: "postponed" })).json.status).toBe("postponed");
    // Un elemento rimandato si approva solo dopo averlo rimesso in attesa
    expect((await api("PATCH", `/analysis-items/${comp.id}`, { status: "approved" })).status).toBe(409);
    expect((await api("PATCH", `/analysis-items/${comp.id}`, { status: "pending" })).json.status).toBe("pending");
    expect((await api("PATCH", `/analysis-items/${comp.id}`, { status: "discarded" })).json.status).toBe("discarded");
    expect((await api("PATCH", `/analysis-items/${comp.id}`, { status: "pending" })).json.status).toBe("pending");

    // Scartare un tool non scrive nulla
    expect((await api("PATCH", `/analysis-items/${tool.id}`, { status: "discarded" })).json.status).toBe("discarded");
    expect(await db.select().from(appToolsTable)).toHaveLength(0);
  });

  it("modifica del payload: validata col capitolo, solo se pending, e approvabile nella stessa richiesta", async () => {
    const app = await createApp();
    const analysisId = await newAnalysis(app.id);
    const item = await addItem(analysisId, "tool", toolPayload());

    const bad = await api("PATCH", `/analysis-items/${item.id}`, { payload: toolPayload({ name: "no no" }) });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/^payload\.name: nome non valido/);

    const edited = await api("PATCH", `/analysis-items/${item.id}`, { payload: toolPayload({ description: "Nuova" }) });
    expect(edited.status, edited.text).toBe(200);
    expect(edited.json.payload.description).toBe("Nuova");
    expect(edited.json.status).toBe("pending");

    const both = await api("PATCH", `/analysis-items/${item.id}`, {
      payload: toolPayload({ description: "Finale" }),
      status: "approved",
    });
    expect(both.status, both.text).toBe(200);
    const [tool] = await db.select().from(appToolsTable).where(eq(appToolsTable.appId, app.id));
    expect(tool!.description).toBe("Finale");

    const comp = await addItem(analysisId, "completion", completionPayload("a", "Primo", 1));
    await api("PATCH", `/analysis-items/${comp.id}`, { status: "postponed" });
    const notPending = await api("PATCH", `/analysis-items/${comp.id}`, { payload: completionPayload("a", "Altro", 1) });
    expect(notPending.status).toBe(409);
  });

  it("modifica e approvazione insieme non applicabili: rollback anche del payload", async () => {
    const app = await createApp();
    const analysisId = await newAnalysis(app.id);
    const item = await addItem(analysisId, "skill", skillPayload);
    const res = await api("PATCH", `/analysis-items/${item.id}`, {
      payload: { ...skillPayload, description: "Cambiata" },
      status: "approved",
    });
    expect(res.status).toBe(400); // list_teams non esiste
    const row = await itemRow(item.id);
    expect(row.status).toBe("pending");
    expect((row.payload as { description: string }).description).toBe("Consulta le squadre");
  });
});

describe("skill degli agenti", () => {
  it("skill approvata visibile in GET /agents/:id/skills; DELETE solo sull'agente giusto", async () => {
    const app = await createApp();
    const general = await generalAgentOf(app.id);
    const analysisId = await newAnalysis(app.id);
    const tool = await addItem(analysisId, "tool", toolPayload());
    const skill = await addItem(analysisId, "skill", skillPayload);
    expect((await api("PATCH", `/analysis-items/${tool.id}`, { status: "approved" })).status).toBe(200);
    expect((await api("PATCH", `/analysis-items/${skill.id}`, { status: "approved" })).status).toBe(200);

    const res = await api("GET", `/agents/${general.id}/skills`);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toHaveLength(1);
    expect(res.json[0]).toMatchObject({
      agentId: general.id,
      name: "consulta_squadre",
      toolNames: ["list_teams"],
      paramsSchema: null,
      status: "active",
    });
    const skillId = res.json[0].id as number;

    const other = await api("POST", "/agents", { appId: app.id, name: "Altro" });
    expect((await api("DELETE", `/agents/${other.json.id}/skills/${skillId}`)).status).toBe(404);
    expect((await api("GET", `/agents/${other.json.id}/skills`)).json).toEqual([]);
    expect((await api("GET", "/agents/999/skills")).status).toBe(404);
    expect((await api("DELETE", `/agents/999/skills/${skillId}`)).status).toBe(404);

    expect((await api("DELETE", `/agents/${general.id}/skills/${skillId}`)).status).toBe(204);
    expect(await db.select().from(agentSkillsTable)).toHaveLength(0);
  });
});

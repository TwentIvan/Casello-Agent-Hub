import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  analysisItemsTable,
  appArchitectureTable,
  appsTable,
  evolutionCyclesTable,
  evolutionRoundsTable,
  githubInstallationsTable,
  usersTable,
} from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "./fake-github";
import { allowTestLoopback, startFakeProvider, type FakeChatReply, type FakeProvider } from "./fake-provider";
import { clearInstallationTokenCache } from "../src/lib/github/app";
import { resetGithubConfigForTests } from "../src/lib/github/config";
import { encryptSecret } from "../src/lib/secrets";
import { buildZip } from "../src/lib/zip-writer";
import { clearAnalysisFinishedListeners, onAnalysisFinished } from "../src/lib/architect/run-analysis";
import { CONSENT_VERSION } from "../src/lib/evolution/consent";
import { EVOLUTION_MESSAGES, roundOutcome } from "../src/lib/evolution/messages";
import { handleAnalysisFinished, trackBackground, waitEvolutionIdleForTests } from "../src/lib/evolution/service";
import { runEvolutionTick } from "../src/lib/evolution/scheduler";

// Prova di flusso del ciclo di evoluzione automatica (3a): route vere con il login di sviluppo, analisi vera in modalità
// `evolution` con il finto provider (consegna completion ed evolution), finto GitHub per il codice e le issue, PGlite.
// Attivazione con consenso → giro dal tick → 3 voci approvate dal ciclo con le loro issue → nessun giro prima della
// frequenza → «Esegui ora» con la voce rifiutata nel prompt → «Ferma» durante l'analisi.

const REPO = "dev/botcave";
const INST = 11;
const KEY = "sk-CHIAVE-EVOLUZIONE";
const REJECTED_TITLE = "Notifiche push agli utenti";
const GH_VARS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", ...GH_VARS] as const;
const saved: Record<string, string | undefined> = {};

let gh: FakeGithub;
let fake: FakeProvider;
let restoreLoopback: () => void;
let server: http.Server;
let base: string;
let resetRunNow: () => void;
let devId: number;
let modelId: number;
let appId: number;

const evidence = [{ source: "code", location: "src/index.ts:1" }];
const completionItem = (key: string, phase: number, title: string, dependsOn: string[] = []) => ({
  key,
  phase,
  area: "Squadre",
  title,
  missing: "Manca il backend",
  evidence,
  goal: title,
  dependsOn,
  files: ["src/index.ts"],
  effort: "S",
  doneWhen: "La funzione risponde",
  implementation: "Aggiungere la route",
});
const evolutionItem = (title: string, priority: number) => ({
  area: "Squadre",
  type: "funzione",
  title,
  motivation: "Utile",
  evidence,
  benefit: "Meno lavoro a mano",
  impact: "medio",
  effort: "S",
  priority,
  implementation: "Endpoint nuovo",
});
const RESULTS = {
  completion: {
    items: [
      completionItem("classifica", 1, "Classifica delle squadre"),
      completionItem("calendario", 1, "Calendario delle partite"),
      completionItem("statistiche", 2, "Statistiche dei giocatori", ["classifica"]),
    ],
  },
  evolution: { items: [evolutionItem("Esportazione CSV", 2), evolutionItem(REJECTED_TITLE, 3)] },
};

type Body = { messages: { role: string; content: string | null }[] };
const userPrompt = (b: Body) => String(b.messages.find((m) => m.role === "user")?.content ?? "");
const phaseOf = (b: Body) => (/FASE 5/.test(userPrompt(b)) ? "completion" : /FASE 6/.test(userPrompt(b)) ? "evolution" : "altro");
const chatBodies = () => fake.requests.filter((r) => r.path.endsWith("/chat/completions")).map((r) => r.body as Body);

/** Il modello consegna subito l'esito della fase. */
function deliver(raw: unknown): FakeChatReply {
  const phase = phaseOf(raw as Body);
  const result = phase === "completion" ? RESULTS.completion : phase === "evolution" ? RESULTS.evolution : { items: [] };
  return {
    content: null,
    toolCalls: [{ id: `submit_${phase}`, name: "submit_result", arguments: JSON.stringify({ result }) }],
    usage: { prompt_tokens: 1_000, completion_tokens: 200 },
  };
}

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`attesa scaduta: ${what}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rounds = async (): Promise<any[]> => (await api("GET", `/apps/${appId}/evolution/rounds`)).json;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  restoreLoopback = allowTestLoopback();
  gh = await startFakeGithub();
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
  });
  resetGithubConfigForTests();
  const { default: app } = await import("../src/app");
  ({ resetEvolutionRunNowLimit: resetRunNow } = await import("../src/middlewares/rate-limit"));
  const { ensureProviderRegistry } = await import("../src/lib/catalog/provider-registry");
  await ensureProviderRegistry();
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
  // Come lo schedulatore: la fine di ogni analisi fa avanzare il suo giro
  onAnalysisFinished((analysisId) => trackBackground(handleAnalysisFinished(analysisId)));
});

afterAll(async () => {
  clearAnalysisFinishedListeners();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await gh.close();
  restoreLoopback();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetGithubConfigForTests();
  await pool.query("TRUNCATE users, apps, ai_accounts, github_installations RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  resetRunNow();
  clearInstallationTokenCache();
  gh.installations.clear();
  gh.zipballs.clear();
  gh.issues.clear();
  gh.labels.clear();
  gh.requests.length = 0;
  gh.failWith = null;
  gh.addInstallation({ id: INST, appId: Number(gh.appId), accountLogin: "dev", accountType: "User", repositorySelection: "all" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.zipballs.set(REPO, buildZip([{ name: "proj/src/index.ts", content: Buffer.from("export const v = 1;\n") }]));
  fake = await startFakeProvider({ apiKey: KEY, chatReply: deliver });

  await pool.query("TRUNCATE users, apps, ai_accounts, github_installations RESTART IDENTITY CASCADE");
  await api("GET", "/auth/me");
  const [dev] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  devId = dev!.id;
  await db.insert(githubInstallationsTable).values({ userId: devId, installationId: INST, accountLogin: "dev", accountType: "User", repositorySelection: "all" });
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: devId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret(KEY), status: "ok" })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  modelId = model!.id;
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Botcave", slug: "botcave", baseUrl: "http://localhost:1", sourceType: "github", sourceRepo: REPO, sourceBranch: "main", sourceInstallationId: INST, functionalDescription: "Gestione di squadre." })
    .returning();
  appId = app!.id;
  await db.insert(appArchitectureTable).values({ appId, summary: "## Sintesi\nSINTESI_DEL_CICLO", repoMap: "src/" });
});

afterEach(async () => {
  await waitEvolutionIdleForTests();
  await fake.close();
});

describe("ciclo di evoluzione automatica: flusso completo", () => {
  it("attivazione, giro con voci approvate e issue, frequenza, Esegui ora con le voci rifiutate, Ferma", async () => {
    // 1. Attivazione con consenso: ciclo attivo e dovuto subito
    const put = await api("PUT", `/apps/${appId}/evolution`, {
      frequency: "weekly",
      itemsPerRound: 3,
      analysisAiModelId: modelId,
      teamTemplateId: null,
      mergeMode: "direct",
      stagingBranch: null,
      stagingUrl: null,
      monthlyBudgetUsd: 10,
      consent: { accepted: true, appSlug: "botcave", version: CONSENT_VERSION },
    });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ status: "active", consentValid: true, activatedByName: expect.any(String) });

    // 2. Il tick avvia il giro; l'analisi ridotta gira davvero e alla fine il giro approva le voci
    expect(await runEvolutionTick()).toBe(1);
    await waitFor(async () => (await rounds())[0]?.status !== "analyzing", "fine del primo giro");
    await waitEvolutionIdleForTests();
    const [first] = await rounds();
    expect(first).toMatchObject({ number: 1, status: "done", outcome: roundOutcome(3) });
    expect(new Set(chatBodies().map(phaseOf))).toEqual(new Set(["completion", "evolution"]));
    expect(chatBodies().every((b) => userPrompt(b).includes("SINTESI_DEL_CICLO"))).toBe(true);
    expect(chatBodies().some((b) => userPrompt(b).includes(REJECTED_TITLE) && userPrompt(b).includes("Voci rifiutate"))).toBe(false);

    const [analysis1] = await db.select().from(analysesTable).where(eq(analysesTable.id, first.analysisId));
    expect(analysis1).toMatchObject({ mode: "evolution", status: "completed", error: null });
    const items1 = await db.select().from(analysisItemsTable).where(eq(analysisItemsTable.analysisId, first.analysisId));
    expect(items1).toHaveLength(5);
    const approved = items1.filter((i) => i.status === "approved");
    expect(approved).toHaveLength(3);
    expect(approved.every((i) => i.chapter === "completion" && i.approvedByCycle)).toBe(true);
    expect([...first.itemIds].sort()).toEqual(approved.map((i) => i.id).sort());
    // Issue create sul finto GitHub e collegate alle voci
    const issues = gh.issues.get(REPO) ?? [];
    expect(issues.map((i) => i.title).sort()).toEqual(["Calendario delle partite", "Classifica delle squadre", "Statistiche dei giocatori"]);
    expect(approved.every((i) => i.issueNumber !== null && i.issueState === "open")).toBe(true);
    // Le voci di evoluzione restano all'utente
    expect(items1.filter((i) => i.chapter === "evolution").every((i) => i.status === "pending" && !i.approvedByCycle)).toBe(true);

    // 3. Prima di sette giorni il tick non avvia nulla
    expect(await runEvolutionTick()).toBe(0);
    expect(await rounds()).toHaveLength(1);

    // 4. L'utente rifiuta una voce del primo giro; «Esegui ora» avvia il secondo e il prompt la elenca tra le rifiutate
    const rejected = items1.find((i) => (i.payload as { title?: string }).title === REJECTED_TITLE)!;
    expect((await api("PATCH", `/analysis-items/${rejected.id}`, { status: "discarded" })).status).toBe(200);
    const before = chatBodies().length;
    fake.delayMs = 15_000; // il modello non risponde: il giro resta in analisi finché non si ferma
    const runNow = await api("POST", `/apps/${appId}/evolution/run-now`);
    expect(runNow.status).toBe(202);
    expect(runNow.json).toMatchObject({ number: 2, status: "analyzing" });
    await waitFor(() => chatBodies().length > before, "prima chiamata del secondo giro");
    const prompt2 = userPrompt(chatBodies()[before]!);
    expect(prompt2).toContain("Voci rifiutate dall'utente nei giri precedenti");
    expect(prompt2).toContain(REJECTED_TITLE);
    expect((await api("GET", `/apps/${appId}/evolution`)).json.openRound).toMatchObject({ number: 2, status: "analyzing" });

    // 5. «Ferma» durante l'analisi: giro fermato, analisi fermata, ciclo in pausa, nessuna voce nuova approvata
    const stop = await api("POST", `/apps/${appId}/evolution/stop`);
    expect(stop.status).toBe(200);
    expect(stop.json).toMatchObject({ status: "paused", pausedReason: EVOLUTION_MESSAGES.stoppedByUser, openRound: null });
    await waitFor(async () => {
      const [a] = await db.select().from(analysesTable).where(eq(analysesTable.id, runNow.json.analysisId));
      return a!.status === "failed";
    }, "chiusura dell'analisi fermata");
    await waitEvolutionIdleForTests();
    const [a2] = await db.select().from(analysesTable).where(eq(analysesTable.id, runNow.json.analysisId));
    expect(a2!.error).toBe(EVOLUTION_MESSAGES.analysisStopped);
    const [second] = await rounds();
    expect(second).toMatchObject({ number: 2, status: "stopped", outcome: EVOLUTION_MESSAGES.stoppedByUser, itemIds: [] });
    const approvedNow = await db
      .select()
      .from(analysisItemsTable)
      .where(and(eq(analysisItemsTable.status, "approved"), eq(analysisItemsTable.approvedByCycle, true)));
    expect(approvedNow).toHaveLength(3);
    // Fermato: il tick non riparte e il contatore della Dashboard lo conta
    expect(await runEvolutionTick()).toBe(0);
    expect((await api("GET", "/dashboard/stats")).json.evolutionCyclesPaused).toBe(1);
  }, 60_000);

  it("il giro non sostituisce l'analisi completa nel piano e le voci approvate dal ciclo restano già pianificate senza issue", async () => {
    // Analisi completa già fatta dall'utente: è la base del piano
    const [full] = await db
      .insert(analysesTable)
      .values({
        appId,
        model: "fake-model",
        aiModelId: modelId,
        status: "completed",
        mode: "full",
        maxTokens: 1_000_000,
        sources: { code: "github", openapi: false, mcp: false, description: false },
      })
      .returning();
    const [fullItem] = await db
      .insert(analysisItemsTable)
      .values({ analysisId: full!.id, chapter: "evolution", ref: "evolution:full", position: 0, payload: evolutionItem("Voce dell'analisi completa", 1), diff: "new" })
      .returning();
    // Issue rifiutate da GitHub: le voci del giro restano approvate senza issue
    gh.failWith = (req) => (req.method === "POST" && /\/(issues|labels)/.test(req.path) ? 403 : null);

    const put = await api("PUT", `/apps/${appId}/evolution`, {
      frequency: "weekly",
      itemsPerRound: 3,
      analysisAiModelId: modelId,
      teamTemplateId: null,
      mergeMode: "direct",
      stagingBranch: null,
      stagingUrl: null,
      monthlyBudgetUsd: 10,
      consent: { accepted: true, appSlug: "botcave", version: CONSENT_VERSION },
    });
    expect(put.status).toBe(200);
    expect(await runEvolutionTick()).toBe(1);
    await waitFor(async () => (await rounds())[0]?.status !== "analyzing", "fine del primo giro");
    await waitEvolutionIdleForTests();
    const [first] = await rounds();
    expect(first).toMatchObject({ number: 1, status: "done", outcome: roundOutcome(3) });
    const items1 = await db.select().from(analysisItemsTable).where(eq(analysisItemsTable.analysisId, first.analysisId));
    expect(items1.filter((i) => i.approvedByCycle).every((i) => i.issueNumber === null)).toBe(true);

    // Il piano resta sull'analisi completa e mostra anche le voci del giro (approvate e in attesa)
    const plan = await api("GET", `/apps/${appId}/plan`);
    expect(plan.status).toBe(200);
    expect(plan.json.analysisId).toBe(full!.id);
    const planIds = new Set(plan.json.items.map((i: { id: number }) => i.id));
    expect(planIds.has(fullItem!.id)).toBe(true);
    for (const item of items1) expect(planIds.has(item.id)).toBe(true);
    expect(plan.json.items).toHaveLength(1 + items1.length);

    // Il secondo giro riceve le voci approvate dal primo come già pianificate, anche senza issue
    const before = chatBodies().length;
    const runNow = await api("POST", `/apps/${appId}/evolution/run-now`);
    expect(runNow.status).toBe(202);
    await waitFor(() => chatBodies().length > before, "prima chiamata del secondo giro");
    const prompt2 = userPrompt(chatBodies()[before]!);
    const planned = prompt2.slice(prompt2.indexOf("Voci già pianificate"));
    expect(prompt2).toContain("Voci già pianificate");
    for (const title of ["Classifica delle squadre", "Calendario delle partite", "Statistiche dei giocatori"]) expect(planned).toContain(title);
    await waitFor(async () => (await rounds())[0]?.status !== "analyzing", "fine del secondo giro");
    await waitEvolutionIdleForTests();
    expect((await api("GET", `/apps/${appId}/plan`)).json.analysisId).toBe(full!.id);
  }, 60_000);

  it("tetto del ciclo raggiunto e consenso da rinnovare mettono in pausa senza chiamare il modello", async () => {
    const body = {
      frequency: "weekly",
      itemsPerRound: 3,
      analysisAiModelId: modelId,
      teamTemplateId: null,
      mergeMode: "direct",
      stagingBranch: null,
      stagingUrl: null,
      monthlyBudgetUsd: 1,
      consent: { accepted: true, appSlug: "botcave", version: CONSENT_VERSION },
    };
    expect((await api("PUT", `/apps/${appId}/evolution`, body)).status).toBe(200);
    // Spesa del mese già oltre il tetto: un'analisi di un giro precedente del ciclo
    const [cycle] = await db.select().from(evolutionCyclesTable).where(eq(evolutionCyclesTable.appId, appId));
    const [prev] = await db.insert(evolutionRoundsTable).values({ cycleId: cycle!.id, number: 1, status: "done" }).returning();
    await db.insert(analysesTable).values({
      appId,
      model: "fake-model",
      aiModelId: modelId,
      status: "completed",
      mode: "evolution",
      evolutionRoundId: prev!.id,
      costUsd: "2",
      tokensUsed: 1_000,
      maxTokens: 150_000,
      sources: { code: "github", openapi: false, mcp: false, description: false },
    });
    const capped = await api("POST", `/apps/${appId}/evolution/run-now`);
    expect([capped.status, capped.json.error]).toEqual([409, EVOLUTION_MESSAGES.budgetReached]);
    expect((await api("GET", `/apps/${appId}/evolution`)).json).toMatchObject({ status: "paused", pausedReason: EVOLUTION_MESSAGES.budgetReached, spentUsd: 2 });

    // Abbassare il tetto non chiede consenso; alzarlo sì. Con il consenso nuovo il ciclo si riprende
    const higher = await api("PUT", `/apps/${appId}/evolution`, { ...body, monthlyBudgetUsd: 20, consent: undefined });
    expect([higher.status, higher.json.error]).toEqual([400, EVOLUTION_MESSAGES.consentRenew]);
    expect((await api("PUT", `/apps/${appId}/evolution`, { ...body, monthlyBudgetUsd: 20 })).status).toBe(200);
    expect((await api("POST", `/apps/${appId}/evolution/resume`)).json).toMatchObject({ status: "active", consentValid: true });

    // Un consenso non più valido (es. testo nuovo) mette in pausa al giro dopo
    await db.update(evolutionCyclesTable).set({ consentHash: "vecchia" }).where(eq(evolutionCyclesTable.appId, appId));
    expect(await runEvolutionTick()).toBe(0);
    expect((await api("GET", `/apps/${appId}/evolution`)).json).toMatchObject({ status: "paused", pausedReason: EVOLUTION_MESSAGES.consentRenew, consentValid: false });
    const resume = await api("POST", `/apps/${appId}/evolution/resume`);
    expect([resume.status, resume.json.error]).toEqual([400, EVOLUTION_MESSAGES.consentRenew]);
    expect(chatBodies()).toHaveLength(0);
  });
});

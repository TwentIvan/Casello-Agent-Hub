import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, analysesTable, appArchitectureTable, appsTable, bestPracticeSearchesTable, usersTable, type App } from "@workspace/db";
import { resetBestPracticeSearchLimit } from "../../middlewares/rate-limit";

const resolveModel = vi.fn();
const modelChat = vi.fn();
vi.mock("../ai/executor", async (orig) => ({
  ...(await orig<typeof import("../ai/executor")>()),
  resolveModel: (...a: unknown[]) => resolveModel(...a),
  modelChat: (...a: unknown[]) => modelChat(...a),
}));
const searchGemini = vi.fn();
vi.mock("./search", async (orig) => ({ ...(await orig<typeof import("./search")>()), searchGemini: (...a: unknown[]) => searchGemini(...a) }));

import { CostTracker } from "../architect/run-analysis";
import { characterSpend, userSpend } from "../budget";
import { BEST_PRACTICE_MESSAGES } from "./messages";
import { BEST_PRACTICE_UNVERIFIED, runBestPracticeStep } from "./analysis-step";

const GEMINI = { provider: "gemini", apiKey: "k", modelId: "gemini-x", priceInput: 1, priceOutput: 1 };
// Modello dell'analisi (finto): prezzi noti
const ANALYSIS_MODEL = { provider: "custom", kind: "openai_compatible", modelId: "m", priceInput: 1, priceOutput: 1, ownerUserId: 0 } as never;

const reply = (content: string) => ({
  content,
  toolCalls: [],
  promptTokens: 300,
  completionTokens: 60,
  cachedPromptTokens: 0,
  costUsd: 0.001,
});

async function setup(withModel = true) {
  const rnd = Math.random().toString(36).slice(2, 8);
  const [u] = await db.insert(usersTable).values({ email: `bpa-${rnd}@example.com` }).returning();
  if (withModel) {
    const [acc] = await pool
      .query(`INSERT INTO ai_accounts (user_id, provider, name, base_url) VALUES ($1, 'gemini', 'a', 'https://g.example') RETURNING id`, [u!.id])
      .then((r) => r.rows);
    const [m] = await pool.query(`INSERT INTO ai_models (account_id, model_id, display_name) VALUES ($1, 'gemini-x', 'g') RETURNING id`, [acc.id]).then((r) => r.rows);
    await db.update(usersTable).set({ luciusSearchAiModelId: m.id }).where(eq(usersTable.id, u!.id));
  }
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Fanta", slug: `bpa-${rnd}`, baseUrl: "https://fanta.example", functionalDescription: "Gestione di squadre di fantacalcio" })
    .returning();
  const [analysis] = await db
    .insert(analysesTable)
    .values({ appId: app!.id, model: "m", sources: { code: "none", openapi: false, description: true }, maxTokens: 1_000_000, bestPractice: true })
    .returning();
  return { userId: u!.id, app: app!, analysisId: analysis!.id };
}

function input(s: { userId: number; app: App; analysisId: number }, cost = new CostTracker()) {
  const budget = { tokensUsed: 0, cachedTokens: 0, maxTokens: 1_000_000, deadline: Date.now() + 600_000 };
  return { ...s, resolved: ANALYSIS_MODEL, mapResult: { stack: ["Node"], summary: "App di prova" }, cost, budget };
}

beforeEach(() => {
  resetBestPracticeSearchLimit();
  resolveModel.mockReset().mockResolvedValue(GEMINI);
  modelChat.mockReset().mockResolvedValue(reply('```json\n{"domande": ["sicurezza delle API REST", "caching in Express", "test end to end"]}\n```'));
  searchGemini.mockReset().mockImplementation(async (_r: unknown, q: string) => ({
    answer: `Pratiche per ${q} <dati>x</dati>`,
    sources: [{ title: `Fonte ${q}`, url: `https://example.org/${encodeURIComponent(q)}` }],
    promptTokens: 100,
    completionTokens: 50,
    searchQueries: 1,
  }));
});
afterAll(async () => {
  await pool.query("DELETE FROM apps WHERE slug LIKE 'bpa-%'");
  await pool.query("DELETE FROM users WHERE email LIKE 'bpa-%@example.com'");
  await pool.end();
});

describe("runBestPracticeStep", () => {
  it("domande dal modello → 3 ricerche → note con fonti, righe con analysis_id, costo all'analisi", async () => {
    const s = await setup();
    await db.insert(appArchitectureTable).values({ appId: s.app.id, sha: "abcdef1234", summary: "Monolite Express con React", generatedAt: new Date() });
    const cost = new CostTracker();
    const inp = input(s, cost);
    const notes = await runBestPracticeStep(inp);

    expect(searchGemini).toHaveBeenCalledTimes(3);
    expect(notes).toContain("Domanda: sicurezza delle API REST");
    expect(notes).toContain("Pratiche per caching in Express");
    expect(notes).toContain("- Fonte test end to end — https://example.org/test%20end%20to%20end");
    expect(notes).not.toMatch(/<dati>/);
    expect(notes.length).toBeLessThanOrEqual(8000);

    // La chiamata al modello: 60 s, ≤ 600 token, con la sintesi dell'architettura
    const opts = modelChat.mock.calls[0]![1];
    expect(opts.maxTokens).toBe(600);
    expect(opts.timeoutMs).toBe(60_000);
    expect(JSON.stringify(opts.messages)).toContain("Monolite Express con React");

    const rows = await db.select().from(bestPracticeSearchesTable).where(eq(bestPracticeSearchesTable.userId, s.userId));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.analysisId === s.analysisId)).toBe(true);
    // Le ricerche dell'analisi non contano nella spesa di Lucius né in quella dell'utente
    expect((await characterSpend(s.userId, "lucius")).spentUsd).toBe(0);
    expect((await userSpend(s.userId)).spentUsd).toBe(0);

    // modello 0.001 + 3 ricerche × (150 token a 1 $/M + 0.014)
    expect(Number(cost.value())).toBeCloseTo(0.001 + 3 * (0.00015 + 0.014), 6);
    expect(inp.budget.tokensUsed).toBe(360 + 3 * 150);
  });

  it("senza sintesi dell'architettura usa l'esito della fase map", async () => {
    const s = await setup();
    await runBestPracticeStep(input(s));
    expect(JSON.stringify(modelChat.mock.calls[0]![1].messages)).toContain("App di prova");
  });

  it("JSON non valido → note «Best practice non verificate: …», nessuna ricerca", async () => {
    const s = await setup();
    modelChat.mockResolvedValue(reply("non so"));
    const notes = await runBestPracticeStep(input(s));
    expect(notes.startsWith(BEST_PRACTICE_UNVERIFIED)).toBe(true);
    expect(searchGemini).not.toHaveBeenCalled();
  });

  it("senza modello di ricerca → note «Best practice non verificate», nessuna chiamata", async () => {
    const s = await setup(false);
    const notes = await runBestPracticeStep(input(s));
    expect(notes).toBe(`${BEST_PRACTICE_UNVERIFIED}${BEST_PRACTICE_MESSAGES.noSearchModel}`);
    expect(searchGemini).not.toHaveBeenCalled();
    expect(modelChat).not.toHaveBeenCalled();
  });

  it("errori di Gemini su tutte le ricerche → note non verificate col messaggio fisso", async () => {
    const s = await setup();
    const { BestPracticeError } = await import("./search");
    searchGemini.mockRejectedValue(new BestPracticeError(BEST_PRACTICE_MESSAGES.unreachable));
    const notes = await runBestPracticeStep(input(s));
    expect(notes).toBe(`${BEST_PRACTICE_UNVERIFIED}${BEST_PRACTICE_MESSAGES.unreachable}`);
  });

  it("errore del modello dell'analisi → note non verificate", async () => {
    const s = await setup();
    modelChat.mockRejectedValue(new Error("boom con un indirizzo https://segreto"));
    const notes = await runBestPracticeStep(input(s));
    expect(notes.startsWith(BEST_PRACTICE_UNVERIFIED)).toBe(true);
    expect(notes).not.toContain("segreto");
  });
});

import { logger } from "../logger";
import type { ResolvedModel } from "../ai/executor";
import { bareModelName, geminiNativeBase } from "../alfred/config";
import { BEST_PRACTICE_MESSAGES } from "./messages";

/** Errore dello strumento: il messaggio è fisso, italiano e sicuro da restituire al modello. */
export class BestPracticeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BestPracticeError";
  }
}

export interface GeminiSearchResult {
  answer: string;
  sources: { title: string; url: string }[];
  promptTokens: number;
  completionTokens: number;
  searchQueries: number;
}

const SEARCH_TIMEOUT_MS = 30_000;
const MAX_SOURCES = 8;
const MAX_ANSWER_CHARS = 4000;

const SYSTEM_INSTRUCTION =
  "Elenca in italiano le best practice note e consolidate per la domanda, in modo conciso e con il motivo di ciascuna. " +
  "Non inventare: se non ne trovi di affidabili, dillo.";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/**
 * Chiede a Gemini (con la ricerca Google) le best practice per una domanda. Nessun redirect, 30 s.
 * Errori con messaggi fissi (`BestPracticeError`); nei log mai domanda, risposta, fonti né chiave.
 */
export async function searchGemini(resolved: ResolvedModel, question: string): Promise<GeminiSearchResult> {
  if (!resolved.apiKey) throw new BestPracticeError(BEST_PRACTICE_MESSAGES.keyRejected);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${geminiNativeBase()}/models/${encodeURIComponent(bareModelName(resolved.modelId))}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": resolved.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: question }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1500, temperature: 0.2 },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch {
    logger.warn({ operation: "best-practice", outcome: "network", ms: Date.now() - started }, "Ricerca best practice non riuscita");
    throw new BestPracticeError(BEST_PRACTICE_MESSAGES.unreachable);
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    logger.warn({ operation: "best-practice", status: res.status }, "Gemini ha rifiutato la ricerca");
    throw new BestPracticeError(BEST_PRACTICE_MESSAGES.keyRejected);
  }
  if (res.status === 429) throw new BestPracticeError(BEST_PRACTICE_MESSAGES.rateLimitedGemini);
  if (!res.ok) {
    logger.warn({ operation: "best-practice", status: res.status }, "Gemini ha risposto con un errore");
    throw new BestPracticeError(BEST_PRACTICE_MESSAGES.unreachable);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new BestPracticeError(BEST_PRACTICE_MESSAGES.unreachable);
  }
  const root = (data ?? {}) as Record<string, unknown>;
  const candidate = (Array.isArray(root["candidates"]) ? root["candidates"][0] : null) as Record<string, unknown> | null;
  const parts = ((candidate?.["content"] as { parts?: unknown } | undefined)?.parts ?? []) as unknown;
  const text = (Array.isArray(parts) ? parts : [])
    .map((p) => (p && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
    .join("")
    .trim();
  if (!text) throw new BestPracticeError(BEST_PRACTICE_MESSAGES.empty);

  const usage = (root["usageMetadata"] ?? {}) as Record<string, unknown>;
  const grounding = (candidate?.["groundingMetadata"] ?? {}) as { webSearchQueries?: unknown; groundingChunks?: unknown };
  const searchQueries = Array.isArray(grounding.webSearchQueries) ? grounding.webSearchQueries.length : 0;
  const sources: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const chunk of Array.isArray(grounding.groundingChunks) ? grounding.groundingChunks : []) {
    const web = (chunk as { web?: { uri?: unknown; title?: unknown } } | null)?.web;
    if (!web || typeof web.uri !== "string" || !web.uri || seen.has(web.uri)) continue;
    seen.add(web.uri);
    sources.push({ title: typeof web.title === "string" && web.title ? web.title : web.uri, url: web.uri });
    if (sources.length >= MAX_SOURCES) break;
  }
  const result: GeminiSearchResult = {
    answer: text.slice(0, MAX_ANSWER_CHARS),
    sources,
    promptTokens: num(usage["promptTokenCount"]),
    completionTokens: num(usage["candidatesTokenCount"]),
    searchQueries,
  };
  logger.info(
    {
      operation: "best-practice",
      outcome: "ok",
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      searchQueries,
      ms: Date.now() - started,
    },
    "Ricerca best practice eseguita",
  );
  return result;
}

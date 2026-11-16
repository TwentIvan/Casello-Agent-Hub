import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNull, lt, ne } from "drizzle-orm";
import { db, bestPracticeSearchesTable } from "@workspace/db";
import { computeCost, type ResolvedModel } from "../ai/executor";
import { BEST_PRACTICE_CACHE_MS, GROUNDING_QUERY_USD } from "./messages";
import type { GeminiSearchResult } from "./search";

export interface StoredSearch {
  id: number;
  question: string;
  answer: string;
  sources: { title: string; url: string }[];
  costUsd: number | null;
  createdAt: Date;
  analysisId: number | null;
}

export interface NewSearch {
  userId: number;
  analysisId?: number | null;
  question: string;
  hash: string;
  aiModelId: number | null;
  result: GeminiSearchResult;
  costUsd: number | null;
}

const RETENTION_MS = 90 * 24 * 3600_000;

/** Domanda su una riga, spazi collassati, 3..300 caratteri; altrimenti null. */
export function normalizeQuestion(q: unknown): string | null {
  if (typeof q !== "string") return null;
  const s = q.replace(/\s+/g, " ").trim();
  return s.length >= 3 && s.length <= 300 ? s : null;
}

/** SHA-256 della domanda in minuscolo. */
export function questionHash(q: string): string {
  return createHash("sha256").update(q.toLowerCase()).digest("hex");
}

/** Costo di una ricerca: token × prezzi più le query di ricerca; null se manca un prezzo e ci sono token. */
export function searchCost(resolved: ResolvedModel, r: GeminiSearchResult): number | null {
  const grounding = r.searchQueries * GROUNDING_QUERY_USD;
  if (r.promptTokens + r.completionTokens === 0) return grounding;
  const tokens = computeCost(r.promptTokens, r.completionTokens, resolved.priceInput, resolved.priceOutput);
  return tokens === null ? null : tokens + grounding;
}

type Row = typeof bestPracticeSearchesTable.$inferSelect;

function toStored(row: Row): StoredSearch {
  return {
    id: row.id,
    question: row.query,
    answer: row.answer,
    sources: row.sources.map((s) => ({ title: s.title, url: s.uri })),
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
    createdAt: row.createdAt,
    analysisId: row.analysisId,
  };
}

/** Ricerca uguale dello stesso utente fatta davvero (non da cache) negli ultimi 7 giorni. */
export async function findCached(userId: number, hash: string, now: Date = new Date()): Promise<StoredSearch | null> {
  const since = new Date(now.getTime() - BEST_PRACTICE_CACHE_MS);
  const [row] = await db
    .select()
    .from(bestPracticeSearchesTable)
    .where(
      and(
        eq(bestPracticeSearchesTable.userId, userId),
        eq(bestPracticeSearchesTable.queryHash, hash),
        isNull(bestPracticeSearchesTable.cachedFrom),
        // Le ricerche andate a vuoto (solo registro dei costi) non si servono dalla cache
        ne(bestPracticeSearchesTable.answer, ""),
        gte(bestPracticeSearchesTable.createdAt, since),
      ),
    )
    .orderBy(desc(bestPracticeSearchesTable.createdAt))
    .limit(1);
  return row ? toStored(row) : null;
}

/** Registra una ricerca vera (cache e registro dei costi). */
export async function recordSearch(row: NewSearch): Promise<StoredSearch> {
  const [saved] = await db
    .insert(bestPracticeSearchesTable)
    .values({
      userId: row.userId,
      analysisId: row.analysisId ?? null,
      queryHash: row.hash,
      query: row.question,
      answer: row.result.answer,
      sources: row.result.sources.map((s) => ({ uri: s.url, title: s.title })),
      aiModelId: row.aiModelId,
      promptTokens: row.result.promptTokens,
      completionTokens: row.result.completionTokens,
      searchQueries: row.result.searchQueries,
      costUsd: row.costUsd === null ? null : row.costUsd.toFixed(6),
    })
    .returning();
  return toStored(saved!);
}

/** Cancella le righe più vecchie di 90 giorni; risponde quante. */
export async function pruneBestPracticeSearches(now: Date = new Date()): Promise<number> {
  const limit = new Date(now.getTime() - RETENTION_MS);
  const rows = await db
    .delete(bestPracticeSearchesTable)
    .where(lt(bestPracticeSearchesTable.createdAt, limit))
    .returning({ id: bestPracticeSearchesTable.id });
  return rows.length;
}

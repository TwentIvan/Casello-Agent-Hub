import { afterAll, describe, expect, it } from "vitest";
import { db, pool, bestPracticeSearchesTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { ResolvedModel } from "../ai/executor";
import { findCached, normalizeQuestion, pruneBestPracticeSearches, questionHash, recordSearch, searchCost } from "./store";

const result = { answer: "a", sources: [{ title: "T", url: "https://x/1" }], promptTokens: 1_000_000, completionTokens: 500_000, searchQueries: 2 };

async function user() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const [u] = await db.insert(usersTable).values({ email: `bp-${rnd}@example.com` }).returning();
  return u!.id;
}
const rec = (userId: number, q: string) =>
  recordSearch({ userId, question: q, hash: questionHash(q), aiModelId: null, result, costUsd: 0.5 });

afterAll(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'bp-%@example.com'");
  await pool.end();
});

describe("normalizzazione", () => {
  it("collassa gli spazi e rispetta 3..300", () => {
    expect(normalizeQuestion("  come   si\nfa ")).toBe("come si fa");
    expect(normalizeQuestion("ab")).toBeNull();
    expect(normalizeQuestion("x".repeat(301))).toBeNull();
    expect(normalizeQuestion(5)).toBeNull();
    expect(questionHash("Ciao")).toBe(questionHash("ciao"));
  });
});

describe("cache", () => {
  it("restituisce la ricerca recente solo allo stesso utente", async () => {
    const u1 = await user();
    const u2 = await user();
    const saved = await rec(u1, "domanda uno");
    const hit = await findCached(u1, questionHash("domanda uno"));
    expect(hit?.id).toBe(saved.id);
    expect(hit?.sources).toEqual([{ title: "T", url: "https://x/1" }]);
    expect(hit?.costUsd).toBe(0.5);
    expect(await findCached(u2, questionHash("domanda uno"))).toBeNull();
  });
  it("scaduta (oltre 7 giorni) o con cached_from non vale", async () => {
    const u = await user();
    const saved = await rec(u, "vecchia");
    expect(await findCached(u, questionHash("vecchia"), new Date(Date.now() + 8 * 24 * 3600_000))).toBeNull();
    await db.update(bestPracticeSearchesTable).set({ cachedFrom: saved.id }).where(eq(bestPracticeSearchesTable.id, saved.id));
    expect(await findCached(u, questionHash("vecchia"))).toBeNull();
  });
});

describe("searchCost", () => {
  const priced = { priceInput: 1, priceOutput: 2 } as ResolvedModel;
  it("token × prezzi più le query", () => {
    expect(searchCost(priced, result)).toBeCloseTo(1 + 1 + 2 * 0.014);
  });
  it("senza prezzi ma con token → null", () => {
    expect(searchCost({ priceInput: null, priceOutput: null } as ResolvedModel, result)).toBeNull();
  });
  it("senza token solo le query", () => {
    expect(searchCost({ priceInput: null, priceOutput: null } as ResolvedModel, { ...result, promptTokens: 0, completionTokens: 0 })).toBeCloseTo(0.028);
  });
});

describe("pulizia", () => {
  it("toglie le righe oltre 90 giorni", async () => {
    const u = await user();
    const old = await rec(u, "da togliere");
    await db
      .update(bestPracticeSearchesTable)
      .set({ createdAt: new Date(Date.now() - 91 * 24 * 3600_000) })
      .where(eq(bestPracticeSearchesTable.id, old.id));
    const fresh = await rec(u, "da tenere");
    expect(await pruneBestPracticeSearches()).toBeGreaterThanOrEqual(1);
    const left = await db.select().from(bestPracticeSearchesTable).where(eq(bestPracticeSearchesTable.userId, u));
    expect(left.map((r) => r.id)).toEqual([fresh.id]);
  });
});

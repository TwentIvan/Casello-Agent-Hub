import { afterAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { db, analysesTable, appsTable, evolutionCyclesTable, evolutionRoundsTable } from "@workspace/db";
import { cycleBudgetBlock, cycleSpend } from "./spend";
import { EVOLUTION_MESSAGES } from "./messages";

// Spesa mensile e tetto del ciclo di evoluzione

// Le App create qui (con cicli, giri e analisi a cascata) non devono restare per i file dopo (es. db-smoke)
afterAll(async () => {
  await db.delete(appsTable).where(like(appsTable.slug, "evo-%"));
});

async function newCycle(budget = "10") {
  const rnd = Math.random().toString(36).slice(2, 8);
  const [app] = await db
    .insert(appsTable)
    .values({ name: rnd, slug: `evo-${rnd}`, description: "x", baseUrl: "http://app.example" })
    .returning();
  const [cycle] = await db.insert(evolutionCyclesTable).values({ appId: app!.id, monthlyBudgetUsd: budget }).returning();
  const [round] = await db.insert(evolutionRoundsTable).values({ cycleId: cycle!.id, number: 1, status: "analyzing" }).returning();
  return { app: app!, cycle: cycle!, round: round! };
}

const analysis = (
  appId: number,
  roundId: number | null,
  costUsd: string | null,
  tokensUsed: number,
  createdAt?: Date,
  mode: "full" | "evolution" = "evolution",
) =>
  db
    .insert(analysesTable)
    .values({ appId, model: "m", sources: {}, maxTokens: 1000, tokensUsed, costUsd, evolutionRoundId: roundId, mode, status: "completed", ...(createdAt ? { createdAt } : {}) } as never);

describe("spesa del ciclo", () => {
  it("somma le analisi del ciclo e conta quelle senza prezzo, ignorando altri cicli", async () => {
    const a = await newCycle();
    const b = await newCycle();
    await analysis(a.app.id, a.round.id, "0.40", 100);
    await analysis(a.app.id, a.round.id, null, 50);
    await analysis(b.app.id, b.round.id, "5", 100);
    expect(await cycleSpend(a.app.id)).toEqual({ spentUsd: expect.closeTo(0.4), unpricedCount: 1 });
  });

  it("esclude le analisi del mese scorso", async () => {
    const a = await newCycle();
    await analysis(a.app.id, a.round.id, "0.40", 100);
    await analysis(a.app.id, a.round.id, "7", 100, new Date("2020-01-15T10:00:00Z"));
    expect((await cycleSpend(a.app.id)).spentUsd).toBeCloseTo(0.4);
  });

  it("non conta le analisi complete dell'App", async () => {
    const a = await newCycle();
    await analysis(a.app.id, null, "3", 100, undefined, "full");
    await analysis(a.app.id, a.round.id, "0.40", 100);
    expect((await cycleSpend(a.app.id)).spentUsd).toBeCloseTo(0.4);
  });

  it("eliminare e ricreare il ciclo nello stesso mese conserva la spesa", async () => {
    const a = await newCycle("1");
    await analysis(a.app.id, a.round.id, "0.80", 100);
    await db.delete(evolutionCyclesTable).where(eq(evolutionCyclesTable.id, a.cycle.id));
    const [again] = await db.insert(evolutionCyclesTable).values({ appId: a.app.id, monthlyBudgetUsd: "0.50" }).returning();
    expect((await cycleSpend(a.app.id)).spentUsd).toBeCloseTo(0.8);
    expect(await cycleBudgetBlock(again!)).toBe(EVOLUTION_MESSAGES.budgetReached);
  });

  it("blocca con il messaggio fisso quando il tetto è raggiunto", async () => {
    const a = await newCycle("0.40");
    expect(await cycleBudgetBlock(a.cycle)).toBeNull();
    await analysis(a.app.id, a.round.id, "0.40", 100);
    expect(await cycleBudgetBlock(a.cycle)).toBe(EVOLUTION_MESSAGES.budgetReached);
  });
});

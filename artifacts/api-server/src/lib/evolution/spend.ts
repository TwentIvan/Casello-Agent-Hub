import { and, eq, gte, sql } from "drizzle-orm";
import { db, analysesTable, evolutionRoundsTable, type EvolutionCycle } from "@workspace/db";
import { isExhausted, monthStart, type Spend } from "../budget";
import { EVOLUTION_MESSAGES } from "./messages";

// Spesa di un ciclo di evoluzione: oggi le analisi dei suoi giri; in 3b si estende con i turni e i compiti della squadra del ciclo.

/** Spesa del ciclo dal `since` (default inizio del mese): costi null con token consumati si contano come senza prezzo. */
export async function cycleSpend(cycleId: number, since: Date = monthStart()): Promise<Spend> {
  const [row] = await db
    .select({
      spent: sql<string>`coalesce(sum(${analysesTable.costUsd}), 0)`,
      unpriced: sql<number>`(count(*) filter (where ${analysesTable.costUsd} is null and ${analysesTable.tokensUsed} > 0))::int`,
    })
    .from(analysesTable)
    .innerJoin(evolutionRoundsTable, eq(analysesTable.evolutionRoundId, evolutionRoundsTable.id))
    .where(and(eq(evolutionRoundsTable.cycleId, cycleId), gte(analysesTable.createdAt, since)));
  return { spentUsd: Number(row?.spent ?? 0), unpricedCount: row?.unpriced ?? 0 };
}

/** Messaggio fisso se il tetto mensile del ciclo è raggiunto, altrimenti null. */
export async function cycleBudgetBlock(cycle: EvolutionCycle): Promise<string | null> {
  const { spentUsd } = await cycleSpend(cycle.id);
  return isExhausted(spentUsd, Number(cycle.monthlyBudgetUsd)) ? EVOLUTION_MESSAGES.budgetReached : null;
}

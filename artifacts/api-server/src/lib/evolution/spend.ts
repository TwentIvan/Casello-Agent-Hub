import { and, eq, gte, sql } from "drizzle-orm";
import { db, analysesTable, type EvolutionCycle } from "@workspace/db";
import { isExhausted, monthStart, type Spend } from "../budget";
import { EVOLUTION_MESSAGES } from "./messages";

// Spesa di un ciclo di evoluzione: oggi le analisi `evolution` della sua App; in 3b si estende con i turni e i compiti della
// squadra del ciclo. Si conta per App e non per giro: eliminando e ricreando il ciclo i giri spariscono (CASCADE) e
// `evolution_round_id` diventa null, ma la spesa del mese resta. C'è al più un ciclo per App, quindi non si confonde.

/** Spesa del ciclo dell'App dal `since` (default inizio del mese): costi null con token consumati si contano come senza prezzo. */
export async function cycleSpend(appId: number, since: Date = monthStart()): Promise<Spend> {
  const [row] = await db
    .select({
      spent: sql<string>`coalesce(sum(${analysesTable.costUsd}), 0)`,
      unpriced: sql<number>`(count(*) filter (where ${analysesTable.costUsd} is null and ${analysesTable.tokensUsed} > 0))::int`,
    })
    .from(analysesTable)
    .where(and(eq(analysesTable.appId, appId), eq(analysesTable.mode, "evolution"), gte(analysesTable.createdAt, since)));
  return { spentUsd: Number(row?.spent ?? 0), unpricedCount: row?.unpriced ?? 0 };
}

/** Messaggio fisso se il tetto mensile del ciclo è raggiunto, altrimenti null. */
export async function cycleBudgetBlock(cycle: EvolutionCycle): Promise<string | null> {
  const { spentUsd } = await cycleSpend(cycle.appId);
  return isExhausted(spentUsd, Number(cycle.monthlyBudgetUsd)) ? EVOLUTION_MESSAGES.budgetReached : null;
}

import { and, eq, gte, sql } from "drizzle-orm";
import { db, teamInstancesTable, teamTasksTable, teamTurnsTable } from "@workspace/db";
import { isExhausted, monthStart, unpricedOf, userBudgetBlock, type Spend } from "../budget";

// Tetto di spesa di una squadra: spesa del mese di compiti e turni dell'istanza (con qualsiasi modello). Prima di
// ogni compito o turno si controlla il tetto della squadra, poi quelli del modello, dell'account e dell'utente.

export const TEAM_BUDGET_REACHED = "tetto di spesa della squadra raggiunto";

/** Spesa del mese della squadra: compiti e turni del capo; i costi null con token si contano a parte. */
export async function teamSpend(instanceId: number, since: Date = monthStart()): Promise<Spend> {
  const [tasks, turns] = await Promise.all([
    db
      .select({ spent: sql<string>`coalesce(sum(${teamTasksTable.costUsd}), 0)`, unpriced: unpricedOf(teamTasksTable) })
      .from(teamTasksTable)
      .where(and(eq(teamTasksTable.instanceId, instanceId), gte(teamTasksTable.createdAt, since))),
    db
      .select({ spent: sql<string>`coalesce(sum(${teamTurnsTable.costUsd}), 0)`, unpriced: unpricedOf(teamTurnsTable) })
      .from(teamTurnsTable)
      .where(and(eq(teamTurnsTable.instanceId, instanceId), gte(teamTurnsTable.createdAt, since))),
  ]);
  return [...tasks, ...turns].reduce<Spend>(
    (acc, r) => ({ spentUsd: acc.spentUsd + Number(r.spent), unpricedCount: acc.unpricedCount + r.unpriced }),
    { spentUsd: 0, unpricedCount: 0 },
  );
}

/** Tetto della squadra raggiunto: il messaggio fisso, altrimenti null (vale anche per i compiti dei nodi). */
export async function teamCapBlock(instanceId: number): Promise<string | null> {
  const [row] = await db
    .select({ cap: teamInstancesTable.monthlyBudgetUsd })
    .from(teamInstancesTable)
    .where(eq(teamInstancesTable.id, instanceId))
    .limit(1);
  if (row?.cap != null) {
    const { spentUsd } = await teamSpend(instanceId);
    if (isExhausted(spentUsd, Number(row.cap))) return TEAM_BUDGET_REACHED;
  }
  return null;
}

/** Motivo del blocco di un compito o turno: prima il tetto della squadra, poi quelli di chi paga il modello. */
export async function teamBudgetBlock(instanceId: number, aiModelId: number | null): Promise<string | null> {
  return (await teamCapBlock(instanceId)) ?? userBudgetBlock(aiModelId);
}

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, releaseTestsTable, teamInstancesTable, teamRoleMessagesTable, teamTasksTable, teamTurnsTable } from "@workspace/db";
import { monthStart, unpricedOf, type Spend } from "../budget";

// Spesa delle squadre (compiti, turni del capo, consultazioni tra ruoli e collaudi dei lavori), senza dipendenze dal ciclo di evoluzione: la usano sia il tetto delle
// squadre (`team-budget.ts`) sia la spesa del ciclo (`evolution/spend.ts`), che altrimenti si importerebbero a vicenda.

/** Tipo del lavoro di riferimento delle squadre create da un ciclo di evoluzione. */
export const EVOLUTION_REF_TYPE = "evoluzione";

async function spendOf(instanceIds: number[] | ReturnType<typeof evolutionInstancesOf>, since: Date): Promise<Spend> {
  const [tasks, turns, tests, consults] = await Promise.all([
    db
      .select({ spent: sql<string>`coalesce(sum(${teamTasksTable.costUsd}), 0)`, unpriced: unpricedOf(teamTasksTable) })
      .from(teamTasksTable)
      .where(and(inArray(teamTasksTable.instanceId, instanceIds), gte(teamTasksTable.createdAt, since))),
    db
      .select({ spent: sql<string>`coalesce(sum(${teamTurnsTable.costUsd}), 0)`, unpriced: unpricedOf(teamTurnsTable) })
      .from(teamTurnsTable)
      .where(and(inArray(teamTurnsTable.instanceId, instanceIds), gte(teamTurnsTable.createdAt, since))),
    db
      .select({ spent: sql<string>`coalesce(sum(${releaseTestsTable.costUsd}), 0)`, unpriced: unpricedOf(releaseTestsTable) })
      .from(releaseTestsTable)
      .where(and(inArray(releaseTestsTable.instanceId, instanceIds), gte(releaseTestsTable.createdAt, since))),
    db
      .select({ spent: sql<string>`coalesce(sum(${teamRoleMessagesTable.costUsd}), 0)`, unpriced: unpricedOf(teamRoleMessagesTable) })
      .from(teamRoleMessagesTable)
      .where(and(inArray(teamRoleMessagesTable.instanceId, instanceIds), gte(teamRoleMessagesTable.createdAt, since))),
  ]);
  return [...tasks, ...turns, ...tests, ...consults].reduce<Spend>(
    (acc, r) => ({ spentUsd: acc.spentUsd + Number(r.spent), unpricedCount: acc.unpricedCount + r.unpriced }),
    { spentUsd: 0, unpricedCount: 0 },
  );
}

function evolutionInstancesOf(appId: number) {
  return db
    .select({ id: teamInstancesTable.id })
    .from(teamInstancesTable)
    .where(and(eq(teamInstancesTable.refAppId, appId), eq(teamInstancesTable.refType, EVOLUTION_REF_TYPE)));
}

/** Spesa del mese della squadra: compiti, turni del capo e collaudi; i costi null con token si contano a parte. */
export async function teamSpend(instanceId: number, since: Date = monthStart()): Promise<Spend> {
  return spendOf([instanceId], since);
}

/**
 * Spesa del mese di tutte le squadre di ciclo dell'App (`ref_type = evoluzione`): una squadra sostituita (modello cambiato,
 * squadra chiusa) continua a contare nel tetto del ciclo.
 */
export async function evolutionTeamsSpend(appId: number, since: Date = monthStart()): Promise<Spend> {
  return spendOf(evolutionInstancesOf(appId), since);
}

import { eq } from "drizzle-orm";
import { db, evolutionCyclesTable, teamInstancesTable } from "@workspace/db";
import { isExhausted, userBudgetBlock } from "../budget";
import { cycleSpend } from "../evolution/spend";
import { EVOLUTION_MESSAGES } from "../evolution/messages";
import { EVOLUTION_REF_TYPE, teamSpend } from "./team-spend";

// Tetto di spesa di una squadra: spesa del mese di compiti e turni dell'istanza (con qualsiasi modello). Prima di
// ogni compito o turno si controlla il tetto della squadra, poi quelli del modello, dell'account e dell'utente.
// La squadra di un ciclo di evoluzione usa il tetto del ciclo, che somma analisi, turni e compiti (spec §15.8).

export { teamSpend } from "./team-spend";

export const TEAM_BUDGET_REACHED = "tetto di spesa della squadra raggiunto";

/** Tetto della squadra raggiunto: il messaggio fisso, altrimenti null (vale anche per i compiti dei nodi). */
export async function teamCapBlock(instanceId: number): Promise<string | null> {
  const [row] = await db
    .select({ cap: teamInstancesTable.monthlyBudgetUsd, refType: teamInstancesTable.refType, appId: teamInstancesTable.refAppId })
    .from(teamInstancesTable)
    .where(eq(teamInstancesTable.id, instanceId))
    .limit(1);
  if (!row) return null;
  if (row.refType === EVOLUTION_REF_TYPE) {
    const [cycle] = await db
      .select({ cap: evolutionCyclesTable.monthlyBudgetUsd, teamInstanceId: evolutionCyclesTable.teamInstanceId })
      .from(evolutionCyclesTable)
      .where(eq(evolutionCyclesTable.appId, row.appId))
      .limit(1);
    if (cycle) {
      const { spentUsd } = await cycleSpend(row.appId);
      return isExhausted(spentUsd, Number(cycle.cap)) ? EVOLUTION_MESSAGES.budgetReached : null;
    }
  }
  if (row.cap != null) {
    const { spentUsd } = await teamSpend(instanceId);
    if (isExhausted(spentUsd, Number(row.cap))) return TEAM_BUDGET_REACHED;
  }
  return null;
}

/** Motivo del blocco di un compito o turno: prima il tetto della squadra, poi quelli di chi paga il modello. */
export async function teamBudgetBlock(instanceId: number, aiModelId: number | null): Promise<string | null> {
  return (await teamCapBlock(instanceId)) ?? userBudgetBlock(aiModelId);
}

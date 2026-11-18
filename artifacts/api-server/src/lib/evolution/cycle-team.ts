// Squadra del ciclo di evoluzione (3c, spec §15.8), parte senza dipendenze dal servizio del ciclo: la usano gli strumenti del
// capo, la coda dei turni e dei compiti e il merge sul branch del lavoro (che il servizio importa a sua volta).
// Log: solo id, numeri ed esiti.

import { and, eq } from "drizzle-orm";
import { db, evolutionCyclesTable, pendingActionsTable, type EvolutionCycle } from "@workspace/db";
import { logger } from "../logger";
import { emitEvent } from "../teams/events";
import { decidePlanItem } from "../teams/plan-decisions";
import { consentValid } from "./consent";

type Executor = Parameters<typeof emitEvent>[1];

/** Ciclo di cui la squadra è la squadra corrente (null per ogni altra squadra). */
export async function cycleForTeam(instanceId: number): Promise<EvolutionCycle | null> {
  const [row] = await db.select().from(evolutionCyclesTable).where(eq(evolutionCyclesTable.teamInstanceId, instanceId)).limit(1);
  return row ?? null;
}

/** La squadra è quella di un ciclo in pausa: niente turni nuovi, compiti nuovi né merge automatici finché non riprende. */
export async function cyclePausedForTeam(instanceId: number): Promise<boolean> {
  const cycle = await cycleForTeam(instanceId);
  return cycle !== null && cycle.status === "paused";
}

/** Evento del giro nel bollettino della squadra del ciclo (se c'è). */
export async function cycleEvent(cycle: Pick<EvolutionCycle, "teamInstanceId">, bulletin: string, executor?: Executor): Promise<void> {
  if (cycle.teamInstanceId === null) return;
  await emitEvent({ instanceId: cycle.teamInstanceId, type: "giro_evoluzione", bulletin }, executor);
}

/**
 * Voce `plan`/`plan_change` appena accodata dal capo della squadra del ciclo: con il ciclo attivo, il consenso valido e la
 * voce di chi paga, si approva da sola (`decided_by_cycle`). Con il ciclo in pausa, un consenso da rinnovare o un'altra
 * squadra la voce resta all'utente. Risponde vero se l'ha approvata.
 */
export async function autoApprovePlanItem(instanceId: number, userId: number, number: number): Promise<boolean> {
  const cycle = await cycleForTeam(instanceId);
  if (!cycle || cycle.status !== "active" || !consentValid(cycle) || cycle.activatedBy !== userId) return false;
  const [row] = await db
    .select()
    .from(pendingActionsTable)
    .where(and(eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.number, number)))
    .limit(1);
  if (!row || row.status !== "pending" || row.teamInstanceId !== instanceId || (row.kind !== "plan" && row.kind !== "plan_change")) return false;
  const result = await decidePlanItem(row, true, null, { byCycle: true });
  if (!result.ok || result.action.status !== "done") {
    logger.info({ instanceId, number }, "Voce di piano non approvata dal ciclo");
    return false;
  }
  await cycleEvent(cycle, `Piano approvato dal ciclo di evoluzione (voce n. ${number}).`);
  logger.info({ instanceId, cycleId: cycle.id, number }, "Voce di piano approvata dal ciclo");
  return true;
}

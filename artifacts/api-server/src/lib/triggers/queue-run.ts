import { agentTriggersTable, triggerSeenItemsTable, type Agent, type AgentTrigger } from "@workspace/db";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { createQueuedRun } from "../run-queue";
import type { DbTransaction as Tx } from "../tools/types";

// Chiave vista e run di un innesco nella stessa transazione (spec §3.2), condivisa da sorveglianza e webhook:
// una chiave vista non diventa mai una seconda run, una run non creata non lascia la chiave.

/** Sentinella: coda delle run piena, annulla la transazione (chiave compresa). */
export class QueueFull extends Error {}
/** Sentinella: innesco non più attivo (pausa, eliminazione o segreto cambiato), annulla la transazione. */
export class NotActive extends Error {}

export const isActive = (id: number) => and(eq(agentTriggersTable.id, id), eq(agentTriggersTable.status, "active"));

/** Blocca la riga dell'innesco se è ancora attivo (e soddisfa `extra`); altrimenti NotActive. */
export async function lockActive(tx: Tx, id: number, extra?: SQL): Promise<void> {
  const [row] = await tx
    .select({ id: agentTriggersTable.id })
    .from(agentTriggersTable)
    .where(extra ? and(isActive(id), extra) : isActive(id))
    .for("update");
  if (!row) throw new NotActive();
}

/**
 * Da chiamare dentro una transazione con la riga dell'innesco già bloccata. Con `key` la inserisce e, solo se
 * la riga è nuova, mette in coda la run; senza `key` la run si crea sempre. Restituisce l'id della run, null se
 * la chiave era già vista. Coda piena → QueueFull. Lo scheduler lo avvia il chiamante dopo il commit.
 */
export async function queueTriggerRun(
  tx: Tx,
  input: { trigger: AgentTrigger; agent: Agent; key: string | null; runInput: string },
): Promise<number | null> {
  const { trigger } = input;
  if (input.key !== null) {
    const inserted = await tx
      .insert(triggerSeenItemsTable)
      .values({ triggerId: trigger.id, itemKey: input.key })
      .onConflictDoNothing()
      .returning({ key: triggerSeenItemsTable.itemKey });
    if (inserted.length === 0) return null;
  }
  const queued = await createQueuedRun({ agent: input.agent, input: input.runInput, triggerId: trigger.id, tx });
  if (!queued.ok) throw new QueueFull();
  await tx
    .update(agentTriggersTable)
    .set({ runsCreated: sql`${agentTriggersTable.runsCreated} + 1` })
    .where(eq(agentTriggersTable.id, trigger.id));
  return queued.run.id;
}

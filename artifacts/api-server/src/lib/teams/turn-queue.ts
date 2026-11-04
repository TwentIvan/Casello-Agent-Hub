import { sql } from "drizzle-orm";
import { db, teamTurnsTable, type TeamTurnReason } from "@workspace/db";
import type { Executor } from "./skills";

// Coda dei turni del capo: al più un turno `queued` per squadra (indice unico parziale); i motivi che
// arrivano mentre un turno è già in coda si accodano allo stesso turno, così ne nasce uno solo.

export type TurnReason = TeamTurnReason;

let onTurnQueued: (instanceId: number) => void = () => {};

/** Collega l'avvio dei turni (Task 5): chiamato dopo ogni accodamento con l'id della squadra. */
export function setOnTurnQueued(fn: (instanceId: number) => void): void {
  onTurnQueued = fn;
}

/** Fa partire il turno accodato (aggancio di `setOnTurnQueued`). */
export function notifyTurnQueued(instanceId: number): void {
  onTurnQueued(instanceId);
}

/**
 * Inserisce il turno `queued` della squadra o aggiunge il motivo a quello già in coda (un'unica istruzione atomica).
 * Con il pool l'avvio del turno scatta subito; dentro una transazione (`executor` ≠ db) il turno non è ancora visibile:
 * chi chiama deve usare `notifyTurnQueued` dopo il commit.
 */
export async function enqueueTurnReason(instanceId: number, reason: TurnReason, executor: Executor = db): Promise<void> {
  await executor
    .insert(teamTurnsTable)
    .values({ instanceId, reasons: [reason] })
    .onConflictDoUpdate({
      target: teamTurnsTable.instanceId,
      targetWhere: sql`${teamTurnsTable.status} = 'queued'`,
      set: { reasons: sql`${teamTurnsTable.reasons} || excluded.reasons` },
    });
  if (executor === db) onTurnQueued(instanceId);
}

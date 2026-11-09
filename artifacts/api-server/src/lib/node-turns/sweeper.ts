// Scadenze e pulizie dei turni delegati al nodo (spec §2-§3): ogni 5 s i turni `queued` non presi entro 20 s diventano
// `expired` (entro 10 minuti se il nodo è occupato con un turno `running`), quelli `running` con lease scaduta `failed`
// `lease_lost` e quelli `running` oltre il tempo del pacchetto più 60 s `failed` `timeout`; ogni ora si cancellano le
// righe chiuse da oltre 30 giorni. All'avvio i turni aperti falliscono `restart`; disattivare, eliminare o rigenerare il token del nodo li
// chiude `failed` `node_disabled` nella transazione del nodo. Ogni chiusura risolve l'attesa di chi ha delegato.

import { and, eq, inArray, isNotNull, lte, notInArray, or, sql } from "drizzle-orm";
import { db, nodeTurnsTable } from "@workspace/db";
import { logger } from "../logger";
import { notifyTurnsClosed, OPEN_TURN_STATUSES } from "./queue";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Un turno in coda non preso entro questo tempo scade (il chiamante ripiega). */
export const TURN_CLAIM_TIMEOUT_MS = 20_000;
/** Su un nodo occupato (un turno `running` con lease viva) un turno in coda attende un posto libero fino a 10 minuti. */
export const TURN_BUSY_QUEUE_TIMEOUT_MS = 600_000;
/** Margine oltre `timeoutMs` del pacchetto prima che l'API chiuda un turno `running` senza report. */
export const TURN_RUNNING_GRACE_MS = 60_000;
export const TURN_SWEEP_INTERVAL_MS = 5_000;
/** Righe chiuse conservate per la traccia tecnica. */
export const TURN_RETENTION_MS = 30 * 24 * 3600_000;
const PURGE_EVERY_MS = 3600_000;

const errName = (err: unknown) => (err instanceof Error ? err.name : "unknown");
/** Data per l'SQL grezzo come la scrive drizzle nelle colonne `timestamp` senza fuso (UTC). */
const sqlTimestamp = (d: Date) => sql`${d.toISOString().replace("T", " ").replace("Z", "")}::timestamp`;

/**
 * Turni in coda da oltre 20 s il cui nodo non ha turni `running` con lease viva, o in coda da oltre 10 minuti in ogni
 * caso → `expired`; restituisce gli id chiusi. Un nodo occupato non fa la presa finché non si libera un posto.
 */
async function expireQueued(now: Date): Promise<number[]> {
  // Nome della tabella esplicito: nella sottoquery una colonna senza tabella si legherebbe alla riga interna
  const nodeBusy = sql`EXISTS (SELECT 1 FROM node_turns busy WHERE busy.node_id = "node_turns"."node_id" AND busy.status = 'running' AND busy.lease_expires_at > ${sqlTimestamp(now)})`;
  const rows = await db
    .update(nodeTurnsTable)
    .set({ status: "expired", package: null, finishedAt: now })
    .where(
      and(
        eq(nodeTurnsTable.status, "queued"),
        or(
          lte(nodeTurnsTable.createdAt, new Date(now.getTime() - TURN_BUSY_QUEUE_TIMEOUT_MS)),
          and(lte(nodeTurnsTable.createdAt, new Date(now.getTime() - TURN_CLAIM_TIMEOUT_MS)), sql`NOT ${nodeBusy}`),
        ),
      ),
    )
    .returning({ id: nodeTurnsTable.id });
  return rows.map((r) => r.id);
}

/**
 * Turni `running` oltre `claimed_at + timeoutMs + 60 s` → `failed` `timeout`: un nodo che rinnova la lease senza mai
 * riferire non tiene aperto il turno per sempre (il nodo stesso ferma `claude` a `timeoutMs`).
 */
async function failOverdue(now: Date): Promise<number[]> {
  const rows = await db
    .update(nodeTurnsTable)
    .set({ status: "failed", errorCode: "timeout", package: null, finishedAt: now })
    .where(
      and(
        eq(nodeTurnsTable.status, "running"),
        isNotNull(nodeTurnsTable.claimedAt),
        isNotNull(nodeTurnsTable.package),
        sql`${nodeTurnsTable.claimedAt} + (((${nodeTurnsTable.package}->>'timeoutMs')::bigint + ${TURN_RUNNING_GRACE_MS}) * interval '1 millisecond') <= ${sqlTimestamp(now)}`,
      ),
    )
    .returning({ id: nodeTurnsTable.id });
  return rows.map((r) => r.id);
}

/** Turni presi con lease scaduta → `failed` `lease_lost` (un report arrivato prima vince: è già chiuso). */
async function failLostLeases(now: Date): Promise<number[]> {
  const rows = await db
    .update(nodeTurnsTable)
    .set({ status: "failed", errorCode: "lease_lost", package: null, finishedAt: now })
    .where(and(eq(nodeTurnsTable.status, "running"), isNotNull(nodeTurnsTable.leaseExpiresAt), lte(nodeTurnsTable.leaseExpiresAt, now)))
    .returning({ id: nodeTurnsTable.id });
  return rows.map((r) => r.id);
}

/** Righe chiuse da oltre 30 giorni; restituisce quante ne ha cancellate. */
async function purgeClosed(now: Date): Promise<number> {
  const rows = await db
    .delete(nodeTurnsTable)
    .where(
      and(
        notInArray(nodeTurnsTable.status, [...OPEN_TURN_STATUSES]),
        isNotNull(nodeTurnsTable.finishedAt),
        lte(nodeTurnsTable.finishedAt, new Date(now.getTime() - TURN_RETENTION_MS)),
      ),
    )
    .returning({ id: nodeTurnsTable.id });
  return rows.length;
}

/**
 * Un giro dei controlli: scadenze e lease perse, più (se `purge`) la pulizia delle righe vecchie. Un errore si
 * registra (solo il tipo), mai come promise rifiutata.
 */
export async function sweepNodeTurns(now: Date = new Date(), opts: { purge?: boolean } = {}): Promise<void> {
  try {
    const expired = await expireQueued(now);
    notifyTurnsClosed(expired);
    if (expired.length > 0) logger.warn({ count: expired.length }, "Turni del nodo non presi in tempo: scaduti");
  } catch (err) {
    logger.error({ errName: errName(err) }, "Scadenza dei turni del nodo non riuscita");
  }
  try {
    const overdue = await failOverdue(now);
    notifyTurnsClosed(overdue);
    if (overdue.length > 0) logger.warn({ count: overdue.length }, "Turni del nodo oltre il tempo massimo: chiusi");
  } catch (err) {
    logger.error({ errName: errName(err) }, "Controllo del tempo dei turni del nodo non riuscito");
  }
  try {
    const lost = await failLostLeases(now);
    notifyTurnsClosed(lost);
    if (lost.length > 0) logger.warn({ count: lost.length }, "Turni del nodo chiusi per lease scaduta");
  } catch (err) {
    logger.error({ errName: errName(err) }, "Controllo delle lease dei turni del nodo non riuscito");
  }
  if (opts.purge === false) return;
  try {
    await purgeClosed(now);
  } catch (err) {
    logger.error({ errName: errName(err) }, "Pulizia dei turni del nodo non riuscita");
  }
}

/** Avvia il controllo ogni 5 s (pulizia una volta all'ora); il timer non tiene vivo il processo. */
export function startNodeTurnSweeper(): () => void {
  let lastPurge = 0;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    const now = new Date();
    const purge = now.getTime() - lastPurge >= PURGE_EVERY_MS;
    if (purge) lastPurge = now.getTime();
    void sweepNodeTurns(now, { purge }).finally(() => {
      running = false;
    });
  }, TURN_SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Avvio dell'API: i turni aperti falliscono `restart` (registro e token in memoria persi). Restituisce quanti. */
export async function failInterruptedNodeTurns(): Promise<number> {
  const rows = await db
    .update(nodeTurnsTable)
    .set({ status: "failed", errorCode: "restart", package: null, finishedAt: new Date() })
    .where(inArray(nodeTurnsTable.status, [...OPEN_TURN_STATUSES]))
    .returning({ id: nodeTurnsTable.id });
  notifyTurnsClosed(rows.map((r) => r.id));
  return rows.length;
}

/**
 * Nella transazione del nodo (disattivazione, eliminazione, rigenerazione del token), prima che `node_id` diventi
 * null: i turni aperti del nodo chiudono `failed` `node_disabled`. Restituisce gli id, da passare a `notifyTurnsClosed`
 * dopo il commit.
 */
export async function failNodeTurns(tx: Tx, nodeId: number): Promise<number[]> {
  const rows = await tx
    .update(nodeTurnsTable)
    .set({ status: "failed", errorCode: "node_disabled", package: null, finishedAt: new Date() })
    .where(and(eq(nodeTurnsTable.nodeId, nodeId), inArray(nodeTurnsTable.status, [...OPEN_TURN_STATUSES])))
    .returning({ id: nodeTurnsTable.id });
  return rows.map((r) => r.id);
}

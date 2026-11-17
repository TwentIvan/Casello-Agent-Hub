// Schedulatore del ciclo di evoluzione (spec §5): all'avvio chiude i giri rimasti senza analisi viva, poi un controllo ogni
// 5 minuti, uno alla volta: chiude come interrotte le analisi dei giri rimaste in coda oltre 30 minuti, fa avanzare i giri
// `analyzing` con l'analisi finita (avvisi di fine persi) e avvia i giri dei cicli dovuti (al più 20). La fine di ogni
// analisi fa avanzare subito il suo giro. Nei log solo id, conteggi ed esiti.

import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, analysesTable, evolutionCyclesTable, evolutionRoundsTable } from "@workspace/db";
import { onAnalysisFinished } from "../architect/run-analysis";
import { logger } from "../logger";
import { EVOLUTION_MESSAGES } from "./messages";
import { EvolutionError, advanceRound, failInterruptedRounds, handleAnalysisFinished, startRound, trackBackground } from "./service";

export {
  EvolutionError,
  advanceRound,
  deleteCycle,
  failInterruptedRounds,
  getCycle,
  listRounds,
  resumeCycle,
  saveCycle,
  startRound,
  stopCycle,
  waitEvolutionIdleForTests,
  type CycleInput,
} from "./service";

export const EVOLUTION_TICK_MS = 300_000;
/** Primo controllo poco dopo l'avvio: con deploy frequenti l'intervallo da solo non arriverebbe mai. */
const EVOLUTION_FIRST_TICK_MS = 60_000;
export const EVOLUTION_CYCLES_PER_TICK = 20;
/** Un'analisi del giro ancora in coda dopo 30 minuti dall'inizio del giro non partirà più (presa in carico persa). */
export const STUCK_QUEUED_MS = 30 * 60_000;

/**
 * Giri `analyzing` con l'analisi ancora `queued` oltre `STUCK_QUEUED_MS` dall'inizio: l'analisi si chiude `failed`
 * (UPDATE condizionato a `queued`) con «giro interrotto dal riavvio», così il giro avanza e l'errore si conta.
 */
async function failStuckQueuedAnalyses(now: Date): Promise<number[]> {
  const stuck = await db
    .select({ roundId: evolutionRoundsTable.id, analysisId: analysesTable.id })
    .from(evolutionRoundsTable)
    .innerJoin(analysesTable, eq(analysesTable.id, evolutionRoundsTable.analysisId))
    .where(
      and(
        eq(evolutionRoundsTable.status, "analyzing"),
        eq(analysesTable.status, "queued"),
        lt(evolutionRoundsTable.startedAt, new Date(now.getTime() - STUCK_QUEUED_MS)),
      ),
    )
    .limit(EVOLUTION_CYCLES_PER_TICK);
  const rounds: number[] = [];
  for (const row of stuck) {
    const closed = await db
      .update(analysesTable)
      .set({ status: "failed", error: EVOLUTION_MESSAGES.restartInterrupted, finishedAt: now })
      .where(and(eq(analysesTable.id, row.analysisId), eq(analysesTable.status, "queued")))
      .returning({ id: analysesTable.id });
    if (closed.length > 0) rounds.push(row.roundId);
  }
  if (rounds.length > 0) logger.warn({ count: rounds.length }, "Analisi dei giri rimaste in coda chiuse");
  return rounds;
}

/** Un controllo: avanza i giri con l'analisi finita, poi avvia i giri dovuti. Risponde quanti giri ha avviato. */
export async function runEvolutionTick(): Promise<number> {
  await failStuckQueuedAnalyses(new Date());
  const finished = await db
    .select({ id: evolutionRoundsTable.id })
    .from(evolutionRoundsTable)
    // leftJoin: un giro rimasto senza analisi (riga eliminata) si chiude come interrotto
    .leftJoin(analysesTable, eq(analysesTable.id, evolutionRoundsTable.analysisId))
    .where(
      and(
        eq(evolutionRoundsTable.status, "analyzing"),
        sql`(${analysesTable.id} is null or ${analysesTable.status} not in ('queued', 'running'))`,
      ),
    )
    .limit(EVOLUTION_CYCLES_PER_TICK);
  for (const r of finished) {
    try {
      await advanceRound(r.id);
    } catch (err) {
      logger.error({ roundId: r.id, errName: err instanceof Error ? err.name : "unknown" }, "Avanzamento del giro non riuscito");
    }
  }

  const now = new Date();
  const due = await db
    .select({ id: evolutionCyclesTable.id })
    .from(evolutionCyclesTable)
    .where(
      and(
        eq(evolutionCyclesTable.status, "active"),
        lte(evolutionCyclesTable.nextRoundAt, now),
        or(isNull(evolutionCyclesTable.nextAttemptAt), lte(evolutionCyclesTable.nextAttemptAt, now)),
        sql`not exists (select 1 from ${evolutionRoundsTable} where ${evolutionRoundsTable.cycleId} = ${evolutionCyclesTable.id}
          and ${evolutionRoundsTable.status} in ('analyzing', 'approving', 'implementing', 'awaiting_release'))`,
      ),
    )
    .orderBy(asc(evolutionCyclesTable.nextRoundAt), asc(evolutionCyclesTable.id))
    .limit(EVOLUTION_CYCLES_PER_TICK);

  let started = 0;
  for (const c of due) {
    try {
      await startRound(c.id);
      started++;
    } catch (err) {
      if (err instanceof EvolutionError) logger.info({ cycleId: c.id, status: err.status, reason: err.message }, "Giro del ciclo non avviato");
      else logger.error({ cycleId: c.id, errName: err instanceof Error ? err.name : "unknown" }, "Avvio del giro non riuscito");
    }
  }
  return started;
}

/** Avvia lo schedulatore; risponde con la funzione che lo ferma. */
export function startEvolutionScheduler(): () => void {
  onAnalysisFinished((analysisId) => trackBackground(handleAnalysisFinished(analysisId)));

  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const count = await runEvolutionTick();
      if (count > 0) logger.info({ count }, "Giri del ciclo di evoluzione avviati");
    } catch (err) {
      logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Controllo del ciclo di evoluzione non riuscito");
    } finally {
      checking = false;
    }
  };

  void trackBackground(
    failInterruptedRounds().catch((err: unknown) => {
      logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Chiusura dei giri interrotti non riuscita");
      return 0;
    }),
  );
  const first = setTimeout(() => void check(), EVOLUTION_FIRST_TICK_MS);
  const timer = setInterval(() => void check(), EVOLUTION_TICK_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

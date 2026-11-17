import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db, bugReportsTable, runsTable } from "@workspace/db";
import { logger } from "../logger";
import { ensureApprovalItem } from "./approval";
import { finalizeReport, startTriage } from "./triage";

// Controllo periodico delle segnalazioni: chiude i vagli con la run finita altrove (riavvio, annullo, altro
// container), riavvia quelli mai partiti e riprova la voce in «Da confermare» che non si era potuta creare.

const SWEEP_MS = 60_000;
const BATCH = 100;
/** Una segnalazione `received` più vecchia di così ha perso l'avvio del vaglio (errore dopo il commit). */
const RECEIVED_GRACE_MS = 60_000;
const FINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

const errName = (err: unknown) => (err instanceof Error ? err.name : typeof err);

export async function sweepBugsOnce(): Promise<void> {
  const inTriage = await db
    .select({ id: bugReportsTable.id, runId: bugReportsTable.triageRunId, runStatus: runsTable.status })
    .from(bugReportsTable)
    .leftJoin(runsTable, eq(runsTable.id, bugReportsTable.triageRunId))
    .where(eq(bugReportsTable.status, "triage"))
    .limit(BATCH);
  for (const row of inTriage) {
    if (row.runId !== null && row.runStatus !== null && !FINAL_RUN_STATUSES.has(row.runStatus)) continue;
    try {
      await finalizeReport(row.id, row.runId);
    } catch (err) {
      logger.error({ reportId: row.id, errName: errName(err) }, "Chiusura del vaglio non riuscita");
    }
  }

  const stuck = await db
    .select({ id: bugReportsTable.id })
    .from(bugReportsTable)
    .where(
      and(
        eq(bugReportsTable.status, "received"),
        lt(bugReportsTable.createdAt, sql`now() - make_interval(secs => ${RECEIVED_GRACE_MS / 1000})`),
      ),
    )
    .limit(BATCH);
  for (const row of stuck) await startTriage(row.id);

  const waiting = await db
    .select({ id: bugReportsTable.id })
    .from(bugReportsTable)
    .where(and(eq(bugReportsTable.status, "pending_approval"), isNull(bugReportsTable.pendingActionId)))
    .limit(BATCH);
  for (const row of waiting) {
    try {
      await ensureApprovalItem(row.id);
    } catch (err) {
      logger.error({ reportId: row.id, errName: errName(err) }, "Voce di approvazione della segnalazione non creata");
    }
  }
}

/** Avvia il controllo ogni 60 s, un giro alla volta; restituisce la funzione che lo ferma. */
export function startBugSweeper(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepBugsOnce();
    } catch (err) {
      logger.error({ errName: errName(err) }, "Controllo delle segnalazioni non riuscito");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}

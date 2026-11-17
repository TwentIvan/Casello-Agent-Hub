import { and, asc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db, bugReportsTable, pendingActionsTable, runsTable } from "@workspace/db";
import { logger } from "../logger";
import { ensureApprovalItem, releaseStaleApprovalItem, resetNoApproverWarnings } from "./approval";
import { finalizeReport, startTriage } from "./triage";

// Controllo periodico delle segnalazioni: chiude i vagli con la run finita altrove (riavvio, annullo, altro
// container), riavvia quelli mai partiti, stacca le voci chiuse senza esito e riprova la voce in «Da confermare» che non
// si era potuta creare.

const SWEEP_MS = 60_000;
const BATCH = 100;
/** Una segnalazione `received` più vecchia di così ha perso l'avvio del vaglio (errore dopo il commit). */
const RECEIVED_GRACE_MS = 60_000;
const FINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled"] as const;
/** Un'App senza nessuno che possa approvare si salta per questo tempo: le sue segnalazioni non riempiono il lotto. */
const NO_APPROVER_SKIP_MS = 10 * 60_000;
const noApproverUntil = new Map<number, number>();

/** Solo per i test: dimentica le App saltate e gli avvisi già dati. */
export function resetBugSweeperMemory(): void {
  noApproverUntil.clear();
  resetNoApproverWarnings();
}

const errName = (err: unknown) => (err instanceof Error ? err.name : typeof err);

export async function sweepBugsOnce(): Promise<void> {
  // Solo i vagli con la run finita o sparita, i meno recenti prima: quelli ancora in corso non occupano il lotto
  const inTriage = await db
    .select({ id: bugReportsTable.id, runId: bugReportsTable.triageRunId })
    .from(bugReportsTable)
    .leftJoin(runsTable, eq(runsTable.id, bugReportsTable.triageRunId))
    .where(
      and(
        eq(bugReportsTable.status, "triage"),
        or(isNull(runsTable.id), inArray(runsTable.status, [...FINAL_RUN_STATUSES])),
      ),
    )
    .orderBy(asc(bugReportsTable.updatedAt), asc(bugReportsTable.id))
    .limit(BATCH);
  for (const row of inTriage) {
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

  // Segnalazioni ancora da approvare con una voce chiusa senza esito (approvazione interrotta: la voce `executing`
  // diventa `failed` all'avvio): si stacca la voce, così sotto se ne crea una nuova
  const orphaned = await db
    .select({ id: bugReportsTable.id, actionId: pendingActionsTable.id })
    .from(bugReportsTable)
    .innerJoin(pendingActionsTable, eq(pendingActionsTable.id, bugReportsTable.pendingActionId))
    .where(and(eq(bugReportsTable.status, "pending_approval"), notInArray(pendingActionsTable.status, ["pending", "executing"])))
    .limit(BATCH);
  for (const row of orphaned) {
    try {
      await releaseStaleApprovalItem(row.id, row.actionId);
    } catch (err) {
      logger.error({ reportId: row.id, errName: errName(err) }, "Voce chiusa della segnalazione non staccata");
    }
  }

  // Voci da creare, le meno recenti prima; le App rimaste senza approvatore si saltano per un po'
  const now = Date.now();
  for (const [appId, until] of noApproverUntil) if (until <= now) noApproverUntil.delete(appId);
  const skippedApps = [...noApproverUntil.keys()];
  const waiting = await db
    .select({ id: bugReportsTable.id, appId: bugReportsTable.appId })
    .from(bugReportsTable)
    .where(
      and(
        eq(bugReportsTable.status, "pending_approval"),
        isNull(bugReportsTable.pendingActionId),
        ...(skippedApps.length > 0 ? [notInArray(bugReportsTable.appId, skippedApps)] : []),
      ),
    )
    .orderBy(asc(bugReportsTable.updatedAt), asc(bugReportsTable.id))
    .limit(BATCH);
  for (const row of waiting) {
    if (noApproverUntil.has(row.appId)) continue;
    try {
      const outcome = await ensureApprovalItem(row.id);
      if (outcome === "no_approver") noApproverUntil.set(row.appId, Date.now() + NO_APPROVER_SKIP_MS);
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

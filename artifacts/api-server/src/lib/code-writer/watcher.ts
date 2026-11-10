import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { appsTable, db, teamCodeTasksTable, teamInstancesTable, teamTasksTable, type TeamCodeTaskRow } from "@workspace/db";
import { githubConfig } from "../github/config";
import { logger } from "../logger";
import { emitEvent } from "../teams/events";
import { patchPlan } from "../teams/plan";
import { enqueueTurnReason, notifyTurnQueued } from "../teams/turn-queue";
import { ciState, ciSummary } from "./ci-state";
import { getPull, readCi, type RepoRef } from "./github-git";

/**
 * Sorveglianza della CI delle PR dei compiti con codice (spec §6): un giro ogni minuto, un'unica volta per esito
 * (`ci_notified_sha` = sha già notificato). Lo stato sta tutto nel DB: nessun recupero all'avvio.
 */

export const CODE_WATCH_INTERVAL_MS = 60_000;
export const CODE_WATCH_BATCH = 20;
/** CI ancora in corso dopo tanto tempo dall'ultimo commit: avviso una volta sola. */
export const CI_PENDING_ALERT_MS = 2 * 3_600_000;

const errName = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/** Ultima esecuzione del compito del PLAN (per collegare l'evento), se si trova. */
async function latestTaskId(instanceId: number, planTaskId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ id: teamTasksTable.id })
    .from(teamTasksTable)
    .where(and(eq(teamTasksTable.instanceId, instanceId), eq(teamTasksTable.planTaskId, planTaskId)))
    .orderBy(desc(teamTasksTable.id))
    .limit(1);
  return row?.id;
}

async function hasActiveExecution(instanceId: number, planTaskId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: teamTasksTable.id })
    .from(teamTasksTable)
    .where(
      and(
        eq(teamTasksTable.instanceId, instanceId),
        eq(teamTasksTable.planTaskId, planTaskId),
        inArray(teamTasksTable.status, ["queued", "running", "waiting_node"]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function watchRow(code: TeamCodeTaskRow, r: RepoRef, now: Date): Promise<void> {
  const t = teamCodeTasksTable;
  const n = code.prNumber!;
  const pull = await getPull(r, n);
  const taskId = await latestTaskId(code.instanceId, code.planTaskId);

  if (pull.state !== "open") {
    const merged = pull.state === "merged";
    // Una sola volta: l'UPDATE condizionato a `open` decide chi emette l'evento; tutto in una transazione
    const won = await db.transaction(async (tx) => {
      const [w] = await tx
        .update(t)
        .set({ prState: pull.state, ciCheckedAt: now, updatedAt: now })
        .where(and(eq(t.id, code.id), eq(t.prState, "open")))
        .returning({ id: t.id });
      if (!w) return false;
      await emitEvent(
        merged
          ? { instanceId: code.instanceId, type: "compito_finito", taskId, bulletin: `Compito ${code.planTaskId}: PR #${n} unita` }
          : { instanceId: code.instanceId, type: "bloccato", taskId, bulletin: `Compito ${code.planTaskId}: PR #${n} chiusa senza merge` },
        tx,
      );
      await enqueueTurnReason(code.instanceId, { type: "pr_closed", taskCodeId: code.id, merged }, tx);
      return true;
    });
    if (won) notifyTurnQueued(code.instanceId);
    return;
  }

  // Commit nuovo sulla PR: la CI riparte e la notifica si riapre
  let headSha = code.headSha;
  let lastCommitAt = code.lastCommitAt ?? now;
  let pendingNotified = code.ciPendingNotified;
  if (pull.headSha !== code.headSha) {
    headSha = pull.headSha;
    lastCommitAt = now;
    pendingNotified = false;
  }

  const snapshot = await readCi(r, pull.headSha);
  const state = ciState(snapshot, now.getTime() - lastCommitAt.getTime());
  const summary = ciSummary(snapshot);
  const finished = state !== "pending";
  // Compito del PLAN ancora in esecuzione: l'esito si notifica al giro dopo la sua fine (il PLAN non va sovrascritto)
  const deferred = finished && pull.headSha !== code.ciNotifiedSha && (await hasActiveExecution(code.instanceId, code.planTaskId));
  const notify = finished && pull.headSha !== code.ciNotifiedSha && !deferred;
  const alertPending = state === "pending" && !pendingNotified && now.getTime() - lastCommitAt.getTime() >= CI_PENDING_ALERT_MS;

  const won = await db.transaction(async (tx) => {
    // Prenotazione condizionata allo stato letto (anche lo sha): due giri o un commit concorrente non la sovrascrivono
    const [w] = await tx
      .update(t)
      .set({
        headSha,
        lastCommitAt,
        ciState: state,
        ciSummary: finished && state !== "none" ? summary : null,
        ciCheckedAt: now,
        updatedAt: now,
        ciPendingNotified: alertPending ? true : pendingNotified,
        // CI rosse di fila: +1 a ogni rossa notificata, azzerate da un esito verde o senza CI (freno di `assegna_compito`)
        ...(notify ? { ciNotifiedSha: pull.headSha, ciFailures: state === "failure" ? sql`${t.ciFailures} + 1` : 0 } : {}),
      })
      .where(
        and(
          eq(t.id, code.id),
          eq(t.prState, "open"),
          code.headSha === null ? sql`${t.headSha} is null` : eq(t.headSha, code.headSha),
          code.ciNotifiedSha === null ? sql`${t.ciNotifiedSha} is null` : eq(t.ciNotifiedSha, code.ciNotifiedSha),
          eq(t.ciPendingNotified, code.ciPendingNotified),
        ),
      )
      .returning({ id: t.id });
    if (!w) return false;
    if (notify) {
      if (state === "success") {
        await emitEvent({ instanceId: code.instanceId, type: "compito_finito", taskId, bulletin: `Compito ${code.planTaskId}: CI verde, PR #${n} pronta per la revisione` }, tx);
      } else if (state === "none") {
        await emitEvent({ instanceId: code.instanceId, type: "compito_finito", taskId, bulletin: `Compito ${code.planTaskId}: nessuna CI configurata, PR #${n} pronta per la revisione` }, tx);
      } else {
        await emitEvent({ instanceId: code.instanceId, type: "bloccato", taskId, bulletin: `Compito ${code.planTaskId}: CI non superata sulla PR #${n}`, detail: summary }, tx);
        await patchPlan(code.instanceId, { tasks: [{ id: code.planTaskId, status: "blocked", outcome: summary }] }, tx);
      }
      await enqueueTurnReason(code.instanceId, { type: "ci_finished", taskCodeId: code.id, outcome: state as "success" | "failure" | "none" }, tx);
    } else if (alertPending) {
      await emitEvent({ instanceId: code.instanceId, type: "bloccato", taskId, bulletin: `CI della PR #${n} non conclusa da 2 ore` }, tx);
    }
    return true;
  });
  if (won && notify) notifyTurnQueued(code.instanceId);
}

/** Un giro: fino a 20 PR aperte di squadre attive, le meno recenti per ultimo controllo per prime. */
export async function watchCodeTasksOnce(now: Date = new Date()): Promise<void> {
  const cfg = githubConfig();
  if (!cfg) return;
  const t = teamCodeTasksTable;
  const rows = await db
    .select({ code: t, installationId: appsTable.sourceInstallationId })
    .from(t)
    .innerJoin(teamInstancesTable, eq(teamInstancesTable.id, t.instanceId))
    .innerJoin(appsTable, eq(appsTable.id, teamInstancesTable.refAppId))
    .where(and(eq(t.prState, "open"), isNotNull(t.prNumber), isNotNull(appsTable.sourceInstallationId), eq(teamInstancesTable.status, "active")))
    .orderBy(sql`${t.ciCheckedAt} asc nulls first`, asc(t.id))
    .limit(CODE_WATCH_BATCH);
  let skipped = 0;
  for (const { code, installationId } of rows) {
    if (installationId === null || code.prNumber === null) {
      skipped += 1;
      continue;
    }
    try {
      await watchRow(code, { cfg, installationId, repo: code.repo }, now);
    } catch (err) {
      logger.warn({ codeTaskId: code.id, instanceId: code.instanceId, errName: errName(err) }, "Controllo della PR non riuscito");
      // Riga a fondo coda: un errore persistente non blocca le altre
      await db.update(t).set({ ciCheckedAt: now }).where(eq(t.id, code.id)).catch(() => undefined);
    }
  }
  if (skipped > 0) logger.info({ count: skipped }, "PR dei compiti senza installazione GitHub: saltate");
}

/** Avvia la sorveglianza ogni minuto, un giro alla volta; restituisce la funzione che la ferma. */
export function startCodeWatcher(): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    watchCodeTasksOnce()
      .catch((err: unknown) => logger.error({ errName: errName(err) }, "Sorveglianza della CI non riuscita"))
      .finally(() => {
        running = false;
      });
  }, CODE_WATCH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

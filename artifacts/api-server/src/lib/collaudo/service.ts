// Ciclo di vita del collaudo di un lavoro (spec 2026-11-26-botcave-collaudo-rilascio §3, §6, §7): nasce con la voce «Porta in
// produzione», lo scheduler lo lancia (al più 3 in corso, uno per App per indice unico), dopo il claim del runner parte il
// collaudatore, all'esito la correzione automatica decide se rimandare il lavoro alla squadra; lo sweeper chiude ciò che resta
// appeso. Ogni cambio di stato con UPDATE condizionati. Chi annulla o chiude per tempo scrive stato ed errore PRIMA di fermare
// l'agente. Log: solo id, sha a 7 ed esiti.

import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  appsTable,
  db,
  pendingActionsTable,
  releaseTestFilesTable,
  releaseTestsTable,
  teamInstancesTable,
  teamWorksTable,
  type ReleaseTestRow,
} from "@workspace/db";
import { logger } from "../logger";
import { emitEvent } from "../teams/events";
import { rejectReleaseForTest } from "../teams/release";
import { expireOpenCommands } from "./commands";
import { collaudoRepo } from "./config";
import { dispatchTest } from "./dispatch";
import { COLLAUDO_MESSAGES } from "./messages";
import { testModelFor } from "./model";
import { autoFixDecision } from "./outcome";
import { runReleaseTest } from "./run-test";
import { issueCode } from "./tokens";

/** Collaudi lanciati o in corso insieme, in tutto. */
export const MAX_ACTIVE_TESTS = 3;
/** Video e screenshot si cancellano dopo 30 giorni. */
export const FILE_RETENTION_MS = 30 * 24 * 60 * 60_000;

const OPEN = ["queued", "dispatching", "running"] as const;
const errName = (err: unknown) => (err instanceof Error ? err.name : "unknown");

// Collaudatori in esecuzione in questo processo, per fermarli quando il collaudo si chiude da fuori
const agents = new Map<number, AbortController>();
// Collaudi tra la presa in carico e il lancio in questo processo: lo sweeper non li tocca
const dispatchingHere = new Set<number>();

/** Ferma il collaudatore del collaudo (se gira qui): da chiamare dopo aver scritto stato ed errore. */
export function stopTestAgent(testId: number): void {
  const controller = agents.get(testId);
  if (!controller) return;
  agents.delete(testId);
  controller.abort();
}

/** Collaudi lanciati in background: lo scheduler riparte dopo ogni chiusura. */
function scheduleInBackground(): void {
  void scheduleReleaseTests().catch((err: unknown) => logger.error({ errName: errName(err) }, "Lancio dei collaudi non riuscito"));
}

/**
 * Chiede il collaudo del lavoro alla sua testa. Idempotente per (lavoro, sha, modo) aperto; un altro collaudo aperto della
 * stessa App (altro lavoro, altra testa o altro modo) si annulla. Senza repository di collaudo nasce `skipped`.
 */
export async function requestReleaseTest(workId: number, mode: "full" | "relight" = "full"): Promise<number | null> {
  const [work] = await db
    .select({ id: teamWorksTable.id, instanceId: teamWorksTable.instanceId, headSha: teamWorksTable.headSha, appId: teamInstancesTable.refAppId })
    .from(teamWorksTable)
    .innerJoin(teamInstancesTable, eq(teamInstancesTable.id, teamWorksTable.instanceId))
    .where(eq(teamWorksTable.id, workId))
    .limit(1);
  if (!work || !work.headSha) return null;
  const sha = work.headSha;

  if (!collaudoRepo()) {
    const [row] = await db
      .insert(releaseTestsTable)
      .values({ appId: work.appId, workId, instanceId: work.instanceId, sha, mode, status: "skipped", error: COLLAUDO_MESSAGES.notConfigured, finishedAt: new Date() })
      .returning({ id: releaseTestsTable.id });
    logger.info({ releaseTestId: row!.id, workId }, "Collaudo saltato: non configurato");
    return row!.id;
  }

  const result = await db.transaction(async (tx) => {
    // La riga dell'App serializza le richieste di collaudo della stessa App
    await tx.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, work.appId)).for("update");
    const [open] = await tx
      .select()
      .from(releaseTestsTable)
      .where(and(eq(releaseTestsTable.appId, work.appId), inArray(releaseTestsTable.status, [...OPEN])))
      .limit(1);
    if (open && open.workId === workId && open.sha === sha && open.mode === mode) return { id: open.id, cancelled: null };
    let cancelled: number | null = null;
    if (open) {
      await tx
        .update(releaseTestsTable)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          codeHash: null,
          codeExpiresAt: null,
          tokenHash: null,
          tokenExpiresAt: null,
          leaseExpiresAt: null,
          tunnelUrl: null,
          tunnelUntil: null,
        })
        .where(eq(releaseTestsTable.id, open.id));
      cancelled = open.id;
    }
    const [row] = await tx
      .insert(releaseTestsTable)
      .values({ appId: work.appId, workId, instanceId: work.instanceId, sha, mode, status: "queued" })
      .returning({ id: releaseTestsTable.id });
    return { id: row!.id, cancelled };
  });

  if (result.cancelled !== null) {
    stopTestAgent(result.cancelled);
    await expireOpenCommands(result.cancelled);
    logger.info({ releaseTestId: result.cancelled, replacedBy: result.id }, "Collaudo annullato da uno più recente");
  }
  logger.info({ releaseTestId: result.id, workId, sha: sha.slice(0, 7), mode }, "Collaudo in coda");
  scheduleInBackground();
  return result.id;
}

let scheduling: Promise<void> | null = null;
let scheduleAgain = false;

/**
 * Lancia i collaudi in coda, dal più vecchio, finché quelli lanciati o in corso sono meno di 3. Una sola esecuzione alla volta
 * in questo processo (una chiamata durante un giro ne chiede un altro); la presa in carico è un UPDATE condizionato a `queued`.
 */
export function scheduleReleaseTests(): Promise<void> {
  if (scheduling) {
    scheduleAgain = true;
    return scheduling;
  }
  scheduling = (async () => {
    try {
      do {
        scheduleAgain = false;
        await scheduleOnce();
      } while (scheduleAgain);
    } finally {
      scheduling = null;
    }
  })();
  return scheduling;
}

async function scheduleOnce(): Promise<void> {
  for (;;) {
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(releaseTestsTable)
      .where(inArray(releaseTestsTable.status, ["dispatching", "running"]));
    if (n >= MAX_ACTIVE_TESTS) return;
    const [next] = await db
      .select()
      .from(releaseTestsTable)
      .where(eq(releaseTestsTable.status, "queued"))
      .orderBy(releaseTestsTable.createdAt, releaseTestsTable.id)
      .limit(1);
    if (!next) return;
    const claimed = await db
      .update(releaseTestsTable)
      .set({ status: "dispatching" })
      .where(and(eq(releaseTestsTable.id, next.id), eq(releaseTestsTable.status, "queued")))
      .returning({ id: releaseTestsTable.id });
    if (claimed.length === 0) continue;
    dispatchingHere.add(next.id);
    try {
      await launch(next);
    } catch (err) {
      logger.error({ releaseTestId: next.id, errName: errName(err) }, "Lancio del collaudo non riuscito");
      await closeDispatching(next.id, "failed", COLLAUDO_MESSAGES.internalError);
    } finally {
      dispatchingHere.delete(next.id);
    }
  }
}

/** Chiude un collaudo ancora `dispatching` (lancio non riuscito o modello non usabile). */
async function closeDispatching(testId: number, status: "failed" | "skipped", error: string): Promise<void> {
  await db
    .update(releaseTestsTable)
    .set({ status, error, finishedAt: new Date(), codeHash: null, codeExpiresAt: null })
    .where(and(eq(releaseTestsTable.id, testId), eq(releaseTestsTable.status, "dispatching")));
}

async function launch(test: ReleaseTestRow): Promise<void> {
  // Il modello si decide prima di accendere il runner: senza modello usabile non si paga un job inutile
  if (test.mode === "full") {
    const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, test.instanceId)).limit(1);
    if (!instance) return closeDispatching(test.id, "failed", COLLAUDO_MESSAGES.internalError);
    const model = await testModelFor(instance);
    if ("skip" in model) {
      logger.info({ releaseTestId: test.id }, "Collaudo saltato: modello non usabile");
      return closeDispatching(test.id, "skipped", model.skip);
    }
  }
  const code = await issueCode(test.id);
  const dispatched = await dispatchTest(test.id, code);
  if (!dispatched.ok) return closeDispatching(test.id, "failed", dispatched.error);
  logger.info({ releaseTestId: test.id, sha: test.sha.slice(0, 7), mode: test.mode }, "Collaudo lanciato");
}

/** Claim riuscito del runner: con `full` parte il collaudatore in background, con `relight` nessun agente. */
export function onTestClaimed(testId: number, mode: "full" | "relight"): void {
  if (mode !== "full") return;
  const controller = new AbortController();
  agents.get(testId)?.abort();
  agents.set(testId, controller);
  void (async () => {
    try {
      await runReleaseTest(testId, controller.signal);
    } finally {
      if (agents.get(testId) === controller) agents.delete(testId);
    }
    const [row] = await db
      .select({ outcome: releaseTestsTable.outcome })
      .from(releaseTestsTable)
      .where(eq(releaseTestsTable.id, testId))
      .limit(1);
    if (row?.outcome) await finishReleaseTest(testId);
  })().catch((err: unknown) => logger.error({ releaseTestId: testId, errName: errName(err) }, "Chiusura del collaudatore non riuscita"));
}

/** Report del runner: il collaudo è chiuso, l'agente (se gira ancora) si ferma e parte il collaudo successivo. */
export function onTestReported(testId: number): void {
  stopTestAgent(testId);
  scheduleInBackground();
}

/**
 * Dopo un esito consegnato: correzione automatica della voce `release` del lavoro. `reject` → voce rifiutata con il resoconto,
 * lavoro alla squadra e rimando contato nella stessa transazione; `keep_exhausted` → evento con «2 correzioni automatiche non
 * sono bastate». Un collaudo annullato o di una testa diversa da quella della voce non decide nulla.
 */
export async function finishReleaseTest(testId: number): Promise<void> {
  const [test] = await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, testId)).limit(1);
  if (!test || test.outcome === null || test.mode !== "full" || (test.status !== "running" && test.status !== "done")) return;
  const [work] = await db.select().from(teamWorksTable).where(eq(teamWorksTable.id, test.workId)).limit(1);
  const [app] = await db.select({ testAutoFix: appsTable.testAutoFix }).from(appsTable).where(eq(appsTable.id, test.appId)).limit(1);
  if (!work || !app || work.headSha !== test.sha) return;
  const [item] =
    work.pendingActionId === null
      ? []
      : await db
          .select({ id: pendingActionsTable.id, status: pendingActionsTable.status, kind: pendingActionsTable.kind })
          .from(pendingActionsTable)
          .where(eq(pendingActionsTable.id, work.pendingActionId))
          .limit(1);
  const itemPending = work.status === "awaiting_release" && item?.kind === "release" && item.status === "pending";
  const decision = autoFixDecision({ outcome: test.outcome, autoFix: app.testAutoFix, autoRejects: work.testAutoRejects, itemPending });
  if (decision === "keep") return;
  if (decision === "keep_exhausted") {
    await emitEvent({ instanceId: work.instanceId, type: "bloccato", bulletin: `Collaudo del lavoro ${work.number}: ${COLLAUDO_MESSAGES.autoFixExhausted}` });
    logger.info({ releaseTestId: testId, workId: work.id }, "Correzioni automatiche esaurite");
    return;
  }
  const rejected = await rejectReleaseForTest(item!.id, test.report ?? COLLAUDO_MESSAGES.noReport, "auto", async (tx) => {
    await tx
      .update(teamWorksTable)
      .set({ testAutoRejects: sql`${teamWorksTable.testAutoRejects} + 1` })
      .where(eq(teamWorksTable.id, work.id));
    await emitEvent({ instanceId: work.instanceId, type: "bloccato", bulletin: `Collaudo del lavoro ${work.number}: problemi, rimandato alla squadra` }, tx);
  });
  logger.info({ releaseTestId: testId, workId: work.id, rejected }, "Correzione automatica del collaudo");
}

/**
 * Controllo periodico: codice non scambiato entro 15 minuti → `failed` «runner non partito…»; token scaduto → «tempo del
 * collaudo scaduto»; lease scaduta → «collaudo interrotto». Con l'esito già consegnato il collaudo chiude `done` (si è perso
 * solo il link dal vivo). Poi via i file più vecchi di 30 giorni.
 */
export async function sweepReleaseTests(now: Date = new Date()): Promise<void> {
  const notHere = dispatchingHere.size > 0 ? sql`${releaseTestsTable.id} not in (${sql.join([...dispatchingHere].map((id) => sql`${id}`), sql`, `)})` : sql`true`;
  const runnerLost = await db
    .update(releaseTestsTable)
    .set({ status: "failed", error: COLLAUDO_MESSAGES.runnerNotStarted, finishedAt: now, codeHash: null, codeExpiresAt: null })
    .where(
      and(
        eq(releaseTestsTable.status, "dispatching"),
        or(isNull(releaseTestsTable.codeExpiresAt), lt(releaseTestsTable.codeExpiresAt, now)),
        notHere,
      ),
    )
    .returning({ id: releaseTestsTable.id });

  const expired = await db
    .select({ id: releaseTestsTable.id, outcome: releaseTestsTable.outcome, tokenExpiresAt: releaseTestsTable.tokenExpiresAt })
    .from(releaseTestsTable)
    .where(
      and(
        eq(releaseTestsTable.status, "running"),
        or(lt(releaseTestsTable.tokenExpiresAt, now), lt(releaseTestsTable.leaseExpiresAt, now), isNull(releaseTestsTable.tokenExpiresAt)),
      ),
    );
  const closed: number[] = [];
  for (const row of expired) {
    const timedOut = row.tokenExpiresAt === null || row.tokenExpiresAt < now;
    const done = row.outcome !== null;
    const [won] = await db
      .update(releaseTestsTable)
      .set({
        status: done ? "done" : "failed",
        ...(done ? {} : { error: timedOut ? COLLAUDO_MESSAGES.timeout : COLLAUDO_MESSAGES.interrupted }),
        finishedAt: now,
        tokenHash: null,
        tokenExpiresAt: null,
        leaseExpiresAt: null,
        tunnelUrl: null,
        tunnelUntil: null,
      })
      .where(and(eq(releaseTestsTable.id, row.id), eq(releaseTestsTable.status, "running")))
      .returning({ id: releaseTestsTable.id });
    if (!won) continue;
    closed.push(row.id);
    stopTestAgent(row.id);
    await expireOpenCommands(row.id);
  }

  await db.delete(releaseTestFilesTable).where(lt(releaseTestFilesTable.createdAt, new Date(now.getTime() - FILE_RETENTION_MS)));

  if (runnerLost.length > 0 || closed.length > 0) {
    logger.warn({ runnerNotStarted: runnerLost.length, closed: closed.length }, "Collaudi chiusi dal controllo periodico");
    scheduleInBackground();
  }
}

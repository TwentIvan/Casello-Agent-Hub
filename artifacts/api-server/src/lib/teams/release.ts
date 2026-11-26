// «Porta in produzione» di un lavoro su branch unico (spec 2026-11-16-botcave-evoluzione-automatica §15.4): solo l'utente
// approva. Approvare unisce il base nel lavoro se è avanzato, apre la PR lavoro → base (non in bozza) e lascia la voce
// `executing`; la sorveglianza (`watchReleasesOnce`) aspetta la CI della PR e la unisce con un commit di merge. Ogni
// esito con UPDATE condizionati (lavoro `releasing`, voce `executing`). Log: id, numeri e sha a 7.

import { and, eq } from "drizzle-orm";
import { db, evolutionRoundsTable, pendingActionsTable, teamInstancesTable, teamWorksTable, type PendingActionRow, type TeamWork } from "@workspace/db";
import { logger } from "../logger";
import { userHasInstallation } from "../github/installations";
import { requestArchitectureRefresh } from "../architecture/scheduler";
import { requestReanalysisCheck } from "../reanalysis/service";
import { classifyLivePull } from "../code-writer/merge";
import { ciState, failedNames } from "../code-writer/ci-state";
import { getPullDetail, mergeBranches, mergeCommit, openReleasePull, readCi, type RepoRef } from "../code-writer/github-git";
import { codeErrorMessage } from "../code-writer/session";
import { CodeWriteError } from "../code-writer/messages";
import { enqueueTurnReason, notifyTurnQueued } from "./turn-queue";
import { emitEvent } from "./events";
import { WORK_MESSAGES, workRepo } from "./works";
import { notifyWorkChanged } from "./work-hooks";
import { COLLAUDO_MESSAGES } from "../collaudo/messages";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const RELEASE_MESSAGES = {
  teamClosed: "squadra chiusa",
  notReady: "il lavoro non è in attesa di Porta in produzione",
  access: WORK_MESSAGES.noAccess,
  conflict: (base: string) => `conflitto con ${base}: va risolto nel lavoro`,
  ciFailed: (names: string) => `CI non superata sulla PR di rilascio: ${names}`,
  ciTimeout: "CI della PR di rilascio non conclusa entro 30 minuti",
  ciNone: "nessuna CI sulla PR di rilascio: aggiungi un workflow che giri sulle PR verso il base",
  pullClosed: "PR di rilascio chiusa senza merge",
  interrupted: "Porta in produzione interrotta: riprova",
  internal: "Porta in produzione non riuscita: riprova più tardi",
  released: (n: number) => `lavoro ${n} in produzione`,
  rejectedNoNote: "rifiutato dall'utente senza nota",
} as const;

/** Attesa massima della CI della PR di rilascio. */
export const RELEASE_CI_TIMEOUT_MS = 30 * 60_000;
/** Lavoro `releasing` senza PR (processo caduto tra la prenotazione e l'apertura): dopo questo tempo si chiude come fallito. */
const RELEASE_STALE_MS = 5 * 60_000;

class NotReady extends Error {}

type Result = { ok: true; action: PendingActionRow } | { ok: false; status: 404 | 409 | 500; message: string };

async function workOf(actionId: number): Promise<TeamWork | null> {
  const [work] = await db.select().from(teamWorksTable).where(eq(teamWorksTable.pendingActionId, actionId)).limit(1);
  return work ?? null;
}

async function repoFor(instanceId: number): Promise<{ ref: RepoRef; instance: { id: number; name: string; status: string; refAppId: number } } | null> {
  const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId)).limit(1);
  if (!instance || instance.activatedBy === null) return null;
  const repo = await workRepo(instance);
  if (!repo || !(await userHasInstallation(instance.activatedBy, repo.ref.installationId))) return null;
  return { ref: repo.ref, instance };
}

/**
 * Esito negativo: voce `failed` col messaggio, lavoro di nuovo `open` (senza voce, con il motivo in `rejection_note`: la
 * sorveglianza non lo richiude da sola, lo richiude il capo con `chiudi_lavoro`) e turno `release_failed`. Una volta sola.
 */
async function failRelease(work: TeamWork, message: string): Promise<void> {
  const won = await db.transaction(async (tx) => {
    const [w] = await tx
      .update(teamWorksTable)
      .set({ status: "open", pendingActionId: null, releasePrNumber: null, releasePrUrl: null, releaseCiSince: null, rejectionNote: message, updatedAt: new Date() })
      .where(and(eq(teamWorksTable.id, work.id), eq(teamWorksTable.status, "releasing")))
      .returning({ id: teamWorksTable.id });
    if (!w) return false;
    if (work.pendingActionId !== null) {
      await tx
        .update(pendingActionsTable)
        .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
        .where(and(eq(pendingActionsTable.id, work.pendingActionId), eq(pendingActionsTable.status, "executing")));
    }
    await emitEvent({ instanceId: work.instanceId, type: "bloccato", bulletin: `Lavoro ${work.number}: ${message}`.slice(0, 300) }, tx);
    await enqueueTurnReason(work.instanceId, { type: "release_failed", workId: work.id, message }, tx);
    return true;
  });
  if (won) {
    notifyTurnQueued(work.instanceId);
    notifyWorkChanged(work.instanceId);
    logger.info({ instanceId: work.instanceId, work: work.number }, "Porta in produzione non riuscita");
  }
}

function errorText(err: unknown): string {
  return codeErrorMessage(err) ?? RELEASE_MESSAGES.internal;
}

/** Corpo della PR di rilascio dai dati pubblici della voce (compiti con issue e PR). */
function releaseBody(action: PendingActionRow): string {
  const detail = (action.argsPublic ?? {}) as { tasks?: { id: string; title: string; issue: number | null; prNumber: number | null }[]; postScripts?: string[] };
  const lines = (detail.tasks ?? []).map((t) => `- ${t.id} ${t.title}${t.prNumber ? ` (#${t.prNumber})` : ""}${t.issue ? ` · closes #${t.issue}` : ""}`);
  const post = detail.postScripts?.length ? `\n\nScript -post da applicare dopo il deploy:\n${detail.postScripts.map((p) => `- ${p}`).join("\n")}` : "";
  return `Lavoro approvato dall'utente in «Porta in produzione».\n\n${lines.join("\n")}${post}\n\nBotcave · voce n. ${action.number}`;
}

/**
 * Approva «Porta in produzione»: squadra non chiusa, lavoro `awaiting_release`, installazione di chi ha attivato; poi voce
 * `executing` e lavoro `releasing` in una transazione, merge del base nel lavoro se è avanzato (conflitto → esito negativo),
 * PR di rilascio aperta o riusata. Risponde con la voce `executing` (o `failed`).
 */
export async function approveRelease(userId: number, action: PendingActionRow): Promise<Result> {
  const work = await workOf(action.id);
  if (!work) return { ok: false, status: 409, message: RELEASE_MESSAGES.notReady };
  const ctx = await repoFor(work.instanceId);
  if (ctx?.instance.status === "closed") return { ok: false, status: 409, message: RELEASE_MESSAGES.teamClosed };
  if (!ctx) return { ok: false, status: 409, message: RELEASE_MESSAGES.access };
  if (work.status !== "awaiting_release") return { ok: false, status: 409, message: RELEASE_MESSAGES.notReady };

  const claimed = await db
    .transaction(async (tx) => {
    const [item] = await tx
      .update(pendingActionsTable)
      .set({ status: "executing", decidedBy: userId, decidedAt: new Date() })
      .where(and(eq(pendingActionsTable.id, action.id), eq(pendingActionsTable.status, "pending")))
      .returning();
    if (!item) return null;
    const [w] = await tx
      .update(teamWorksTable)
      .set({ status: "releasing", updatedAt: new Date() })
      .where(and(eq(teamWorksTable.id, work.id), eq(teamWorksTable.status, "awaiting_release")))
      .returning();
    // Lavoro non più in attesa: si annulla anche la prenotazione della voce
    if (!w) throw new NotReady();
    return { item, work: w };
  })
    .catch((err: unknown) => {
      if (err instanceof NotReady) return null;
      throw err;
    });
  if (!claimed) return { ok: false, status: 409, message: RELEASE_MESSAGES.notReady };
  // Voce decisa: il collaudo del lavoro non serve più (import dinamico: il collaudo importa questo modulo)
  await (await import("../collaudo/service")).cancelReleaseTestsQuietly(work.instanceId);

  try {
    const merged = await mergeBranches(ctx.ref, {
      base: work.branch,
      head: work.baseBranch,
      message: `Unisce ${work.baseBranch} nel lavoro ${work.number} prima del rilascio`,
    });
    if (merged.result === "conflict") {
      await failRelease(claimed.work, RELEASE_MESSAGES.conflict(work.baseBranch));
    } else {
      const pull = await openReleasePull(ctx.ref, {
        head: work.branch,
        base: work.baseBranch,
        title: `Lavoro ${work.number} di ${ctx.instance.name}`.slice(0, 250),
        body: releaseBody(action),
      });
      await db
        .update(teamWorksTable)
        .set({ releasePrNumber: pull.number, releasePrUrl: pull.url, releaseCiSince: new Date(), ...(merged.result === "merged" ? { headSha: merged.sha } : {}), updatedAt: new Date() })
        .where(and(eq(teamWorksTable.id, work.id), eq(teamWorksTable.status, "releasing")));
      logger.info({ instanceId: work.instanceId, work: work.number, pr: pull.number }, "PR di rilascio aperta");
    }
  } catch (err) {
    logger.error({ instanceId: work.instanceId, work: work.number, errName: err instanceof Error ? err.name : "Error" }, "Porta in produzione non avviata");
    await failRelease(claimed.work, errorText(err));
  }
  const [row] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.id, action.id)).limit(1);
  return row ? { ok: true, action: row } : { ok: false, status: 404, message: RELEASE_MESSAGES.notReady };
}

/**
 * Rifiuto dentro la transazione del rifiuto della voce: lavoro di nuovo `open` con la nota (la sorveglianza non lo richiude da
 * sola), turno `request` al capo con la nota. Il chiamante sveglia la coda dei turni dopo il commit.
 */
export async function rejectRelease(
  action: PendingActionRow,
  note: string | null,
  tx: Tx,
  turnText?: (workNumber: number) => string,
): Promise<number | null> {
  const [w] = await tx
    .update(teamWorksTable)
    .set({ status: "open", pendingActionId: null, rejectionNote: note ?? RELEASE_MESSAGES.rejectedNoNote, updatedAt: new Date() })
    .where(and(eq(teamWorksTable.pendingActionId, action.id), eq(teamWorksTable.status, "awaiting_release")))
    .returning();
  if (!w) return null;
  const text = turnText
    ? turnText(w.number)
    : note
    ? `L'utente ha rifiutato «Porta in produzione» del lavoro ${w.number} con questa nota: ${note}. Il lavoro è di nuovo aperto: correggi con compiti sul branch del lavoro, poi chiudi_lavoro.`
    : `L'utente ha rifiutato «Porta in produzione» del lavoro ${w.number} senza nota: chiedigli cosa correggere con segnala.`;
  await enqueueTurnReason(w.instanceId, { type: "request", text, source: "system" }, tx);
  return w.instanceId;
}

/** Motivo del rifiuto sul giro del ciclo: come la nota dell'utente letta dal ciclo, al più 500 caratteri. */
const CYCLE_NOTE_MAX = 500;

/** Nota del rifiuto di una voce dal collaudo: al più 4 000 caratteri. */
export const TEST_REJECT_NOTE_MAX = 4_000;

/**
 * Rifiuto della voce `release` a nome del collaudo (correzione automatica, «Rimanda alla squadra»): come il rifiuto dell'utente,
 * voce `rejected` con la nota, lavoro di nuovo `open`, turno `request` del capo e avviso del cambio di lavoro, tutto in una
 * transazione con `onRejected` (es. il conteggio dei rimandi automatici). Il testo per il capo dice chi ha deciso: il collaudo
 * (`auto`) o l'utente (`user`). Voce non più in attesa o lavoro non più in attesa di «Porta in produzione» → false, nulla scritto.
 */
export async function rejectReleaseForTest(
  actionId: number,
  note: string,
  source: "auto" | "user",
  onRejected?: (tx: Tx, instanceId: number) => Promise<void>,
): Promise<boolean> {
  const text = note.slice(0, TEST_REJECT_NOTE_MAX);
  const notRejected = new Error("voce non rifiutata");
  let instanceId: number;
  try {
    instanceId = await db.transaction(async (tx) => {
      const [rejected] = await tx
        .update(pendingActionsTable)
        .set({ status: "rejected", decidedAt: new Date(), decisionNote: text })
        .where(and(eq(pendingActionsTable.id, actionId), eq(pendingActionsTable.kind, "release"), eq(pendingActionsTable.status, "pending")))
        .returning();
      if (!rejected) throw notRejected;
      const turnText = (n: number) => (source === "auto" ? COLLAUDO_MESSAGES.autoRejectTurn(n, text) : COLLAUDO_MESSAGES.userRejectTurn(n, text));
      const id = await rejectRelease(rejected, text, tx, turnText);
      // Voce in attesa ma lavoro già altrove: niente rifiuto a metà
      if (id === null) throw notRejected;
      // Giro del ciclo di evoluzione che seguiva la voce: il motivo è il resoconto del collaudo, mai «nota dell'utente»
      await tx
        .update(evolutionRoundsTable)
        .set({ rejectionNote: COLLAUDO_MESSAGES.cycleRejectionNote(text).slice(0, CYCLE_NOTE_MAX) })
        .where(and(eq(evolutionRoundsTable.pendingActionId, actionId), eq(evolutionRoundsTable.status, "awaiting_release")));
      if (onRejected) await onRejected(tx, id);
      return id;
    });
  } catch (err) {
    if (err === notRejected) return false;
    throw err;
  }
  notifyTurnQueued(instanceId);
  notifyWorkChanged(instanceId);
  // «Rimanda alla squadra» (a mano): un «Riaccendi» ancora aperto non serve più
  if (source === "user") await (await import("../collaudo/service")).cancelReleaseTestsQuietly(instanceId);
  return true;
}

/** Giro della sorveglianza sui lavori `releasing` (al più 20): CI della PR di rilascio, poi merge o esito negativo. */
export async function watchReleasesOnce(now: Date = new Date()): Promise<void> {
  const rows = await db.select().from(teamWorksTable).where(eq(teamWorksTable.status, "releasing")).limit(20);
  for (const work of rows) {
    try {
      await watchRelease(work, now);
    } catch (err) {
      logger.error({ instanceId: work.instanceId, work: work.number, errName: err instanceof Error ? err.name : "Error" }, "Controllo della PR di rilascio non riuscito");
    }
  }
}

async function watchRelease(work: TeamWork, now: Date): Promise<void> {
  if (work.releasePrNumber === null) {
    if (now.getTime() - work.updatedAt.getTime() > RELEASE_STALE_MS) await failRelease(work, RELEASE_MESSAGES.interrupted);
    return;
  }
  const ctx = await repoFor(work.instanceId);
  if (!ctx) return failRelease(work, RELEASE_MESSAGES.access);
  const pull = await getPullDetail(ctx.ref, work.releasePrNumber);
  if (pull.state === "merged") return finishReleased(work, ctx.instance.refAppId);
  if (pull.state === "closed") return failRelease(work, RELEASE_MESSAGES.pullClosed);
  const since = work.releaseCiSince ? now.getTime() - work.releaseCiSince.getTime() : 0;
  const snapshot = await readCi(ctx.ref, pull.headSha);
  const state = ciState(snapshot, since);
  if (state === "failure") return failRelease(work, RELEASE_MESSAGES.ciFailed(failedNames(snapshot).join(", ")).slice(0, 300));
  if (state === "none") return failRelease(work, RELEASE_MESSAGES.ciNone);
  if (state === "pending") {
    if (since > RELEASE_CI_TIMEOUT_MS) await failRelease(work, RELEASE_MESSAGES.ciTimeout);
    return;
  }
  // CI verde: workflow e meccanismo delle migrazioni restano rifiutati, gli script -post sono ammessi (l'utente li ha visti).
  // Un rifiuto di GitHub (regole del branch, commit di merge non ammessi, testa cambiata) chiude il rilascio con il messaggio fisso
  let merged: { sha: string };
  try {
    const cls = await classifyLivePull(ctx.ref, pull);
    if (cls.kind === "refuse") return failRelease(work, cls.message);
    merged = await mergeCommit(ctx.ref, pull.number, { sha: pull.headSha, title: `Lavoro ${work.number} di ${ctx.instance.name} (#${pull.number})`.slice(0, 250) });
  } catch (err) {
    if (err instanceof CodeWriteError && err.status !== null && err.status < 500) return failRelease(work, err.message);
    throw err;
  }
  logger.info({ instanceId: work.instanceId, work: work.number, pr: pull.number, sha: merged.sha.slice(0, 7) }, "Lavoro portato in produzione");
  await finishReleased(work, ctx.instance.refAppId);
}

async function finishReleased(work: TeamWork, appId: number): Promise<void> {
  const won = await db.transaction(async (tx) => {
    const [w] = await tx
      .update(teamWorksTable)
      .set({ status: "released", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(teamWorksTable.id, work.id), eq(teamWorksTable.status, "releasing")))
      .returning({ id: teamWorksTable.id });
    if (!w) return false;
    if (work.pendingActionId !== null) {
      await tx
        .update(pendingActionsTable)
        .set({ status: "done", result: RELEASE_MESSAGES.released(work.number), finishedAt: new Date() })
        .where(and(eq(pendingActionsTable.id, work.pendingActionId), eq(pendingActionsTable.status, "executing")));
    }
    return true;
  });
  if (!won) return;
  notifyWorkChanged(work.instanceId);
  void requestArchitectureRefresh(appId, { bypassOff: false, clearBackoff: false }).catch((e: unknown) =>
    logger.error({ appId, errName: e instanceof Error ? e.name : "Error" }, "Aggiornamento della sintesi dell'architettura non richiesto"),
  );
  // Rianalisi automatica: il catalogo dei tool si riallinea al codice unito (solo con `auto_reanalysis`)
  requestReanalysisCheck(appId);
}


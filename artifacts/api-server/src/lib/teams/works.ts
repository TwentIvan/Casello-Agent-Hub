// Lavoro su branch unico delle squadre con codice (spec 2026-11-16-botcave-evoluzione-automatica §15.2): il primo compito con
// codice apre il lavoro e il suo branch dalla testa del base dell'App; i compiti con codice partono dal branch del lavoro e
// vanno in fila (uno alla volta, il successivo dopo il merge della PR del precedente). Log: id, numeri e sha a 7.

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db,
  appsTable,
  pendingActionsTable,
  teamInstancesTable,
  teamCodeTasksTable,
  teamTasksTable,
  teamWorksTable,
  type TeamInstanceRow,
  type TeamWork,
} from "@workspace/db";
import { logger } from "../logger";
import { githubConfig } from "../github/config";
import { createBranch, forceUpdateRef, getBranchHead, getDefaultBranch, type RepoRef } from "../code-writer/github-git";
import { enqueueReleaseItem } from "../actions/queue";
import { emitEvent } from "./events";
import { getApprovedPlan, getPlan } from "./plan";
import { checkStagingBranch } from "./staging";
import { isUniqueViolation } from "../pg-errors";
import { codeWrites } from "./manifest";
import { userHasInstallation } from "../github/installations";
import { notifyWorkChanged } from "./work-hooks";

export const WORK_MESSAGES = {
  queueBusy: "un compito con codice è già in corso nel lavoro: aspetta che la sua PR sia unita",
  noCi: "nessuna CI sul branch: aggiungi un workflow che giri sui branch botcave/**",
  alreadyClosed: "lavoro già chiuso: aspetta la decisione su Porta in produzione",
  nothingMerged: "nessun compito unito nel lavoro",
  workPull: "le PR del lavoro le unisce Botcave quando la CI è verde",
  noStaging: "nessuna versione di prova configurata per l'App",
  noAccess: "accesso al repository non disponibile",
  workNotOpen: "il lavoro è in attesa di Porta in produzione: aspetta la decisione dell'utente prima di assegnare compiti con codice",
  stagingFailed: "versione di prova non aggiornata: GitHub ha rifiutato la scrittura del branch di prova",
  closeBusy: "un compito con codice è ancora in corso: aspetta il suo esito prima di chiudere il lavoro",
  closePullPending: "una PR del lavoro ha la CI in corso o verde e Botcave la sta per unire: aspetta il merge prima di chiudere il lavoro",
} as const;

/** Stati di un lavoro non ancora chiuso (indice unico parziale `team_works_one_open`). */
export const OPEN_WORK_STATUSES = ["open", "awaiting_release", "releasing"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export class WorkError extends Error {}

export function workBranch(instanceId: number, n: number): string {
  return `botcave/lavoro-${instanceId}-${n}`;
}

/** Il ruolo scrive codice (`code: write|merge`): i suoi compiti partono dal branch del lavoro e vanno in fila. */
export function roleWritesCode(instance: TeamInstanceRow, roleKey: string): boolean {
  const role = instance.roles.find((r) => r.key === roleKey);
  return role !== undefined && codeWrites(role.code ?? "none");
}

/** Lavoro non chiuso della squadra, se c'è. */
export async function getOpenWork(instanceId: number, executor: Executor = db): Promise<TeamWork | null> {
  const [row] = await executor
    .select()
    .from(teamWorksTable)
    .where(and(eq(teamWorksTable.instanceId, instanceId), inArray(teamWorksTable.status, [...OPEN_WORK_STATUSES])))
    .limit(1);
  return row ?? null;
}

/** Repository dell'App di riferimento tramite l'App GitHub, con il branch base salvato (null = predefinito). */
export async function workRepo(instance: TeamInstanceRow): Promise<{ ref: RepoRef; sourceBranch: string | null; stagingBranch: string | null; stagingUrl: string | null } | null> {
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, instance.refAppId)).limit(1);
  const cfg = githubConfig();
  if (!app || !cfg || app.sourceType !== "github" || !app.sourceRepo || app.sourceInstallationId === null) return null;
  // Ogni scrittura del lavoro (branch, versione di prova) vuole l'installazione di chi ha attivato la squadra
  if (instance.activatedBy === null || !(await userHasInstallation(instance.activatedBy, app.sourceInstallationId))) return null;
  return {
    ref: { cfg, installationId: app.sourceInstallationId, repo: app.sourceRepo },
    sourceBranch: app.sourceBranch,
    stagingBranch: app.stagingBranch,
    stagingUrl: app.stagingUrl,
  };
}

/**
 * Lavoro non chiuso della squadra o, se manca, uno nuovo: branch `botcave/lavoro-<squadra>-<n>` creato (mai forzato) dalla
 * testa del base dell'App, poi la riga con il numero successivo. Due aperture concorrenti: l'indice unico parziale ne lascia
 * passare una, l'altra rilegge e riusa. Senza repository dell'App tramite installazione → `WorkError` con il messaggio fisso.
 */
export async function ensureWorkForCodeTask(instance: TeamInstanceRow): Promise<TeamWork> {
  const existing = await getOpenWork(instance.id);
  if (existing) return existing;
  const repo = await workRepo(instance);
  if (!repo) throw new WorkError(WORK_MESSAGES.noAccess);
  const baseBranch = repo.sourceBranch ?? (await getDefaultBranch(repo.ref));
  const baseSha = await getBranchHead(repo.ref, baseBranch);
  if (!baseSha) throw new WorkError(WORK_MESSAGES.noAccess);
  const [{ next } = { next: 1 }] = await db
    .select({ next: sql<number>`coalesce(max(${teamWorksTable.number}), 0)::int + 1` })
    .from(teamWorksTable)
    .where(eq(teamWorksTable.instanceId, instance.id));
  const branch = workBranch(instance.id, next);
  await createBranch(repo.ref, branch, baseSha);
  try {
    const [row] = await db
      .insert(teamWorksTable)
      .values({ instanceId: instance.id, number: next, repo: repo.ref.repo, branch, baseBranch, baseSha, headSha: baseSha })
      .returning();
    logger.info({ instanceId: instance.id, work: next, sha: baseSha.slice(0, 7) }, "Lavoro su branch unico aperto");
    return row!;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await getOpenWork(instance.id);
    if (raced) return raced;
    throw err;
  }
}

/**
 * Fila dei compiti con codice (da chiamare con la squadra bloccata): il messaggio fisso se c'è già un compito di un ruolo
 * che scrive codice in coda, in corso o in attesa del nodo, oppure una PR del lavoro ancora aperta.
 */
export async function codeQueueBlock(instance: TeamInstanceRow, workId: number, tx: Executor, planTaskId: string | null = null): Promise<string | null> {
  // Il lavoro deve essere ancora aperto (non in prova né in rilascio)
  const [work] = await tx.select({ status: teamWorksTable.status }).from(teamWorksTable).where(eq(teamWorksTable.id, workId)).limit(1);
  if (work && work.status !== "open") return WORK_MESSAGES.workNotOpen;
  const writers = instance.roles.filter((r) => codeWrites(r.code ?? "none")).map((r) => r.key);
  if (writers.length > 0) {
    const [busy] = await tx
      .select({ id: teamTasksTable.id })
      .from(teamTasksTable)
      .where(
        and(
          eq(teamTasksTable.instanceId, instance.id),
          inArray(teamTasksTable.roleKey, writers),
          inArray(teamTasksTable.status, ["queued", "running", "waiting_node"]),
        ),
      )
      .limit(1);
    if (busy) return WORK_MESSAGES.queueBusy;
  }
  const [open] = await tx
    .select({ id: teamCodeTasksTable.id })
    .from(teamCodeTasksTable)
    .where(
      and(
        eq(teamCodeTasksTable.workId, workId),
        eq(teamCodeTasksTable.prState, "open"),
        // La PR del compito che si riassegna non lo blocca: riparte dal suo branch (CI rossa, CI assente, merge rifiutato)
        ...(planTaskId !== null ? [sql`${teamCodeTasksTable.planTaskId} <> ${planTaskId}`] : []),
      ),
    )
    .limit(1);
  return open ? WORK_MESSAGES.queueBusy : null;
}

/**
 * Una PR del lavoro è ancora aperta con la CI in corso o verde: Botcave la unirà nel lavoro, quindi chiuderlo adesso la
 * lascerebbe fuori da «Porta in produzione». Le PR con la CI rossa o senza CI (compito `blocked`) non trattengono il lavoro.
 */
export async function workPullPending(workId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: teamCodeTasksTable.id })
    .from(teamCodeTasksTable)
    .where(and(eq(teamCodeTasksTable.workId, workId), eq(teamCodeTasksTable.prState, "open"), inArray(teamCodeTasksTable.ciState, ["pending", "success"])))
    .limit(1);
  return row !== undefined;
}

/**
 * Riga di `team_code_tasks` di prima del lavoro su branch unico (PR verso il base, `work_id` nullo): il compito continua
 * come prima, sul base registrato, senza lavoro né fila.
 */
async function legacyCodeTask(instanceId: number, planTaskId: string): Promise<{ baseBranch: string } | null> {
  const [row] = await db
    .select({ baseBranch: teamCodeTasksTable.baseBranch })
    .from(teamCodeTasksTable)
    .where(
      and(
        eq(teamCodeTasksTable.instanceId, instanceId),
        eq(teamCodeTasksTable.planTaskId, planTaskId),
        sql`${teamCodeTasksTable.workId} is null`,
        sql`${teamCodeTasksTable.prNumber} is not null`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function isLegacyCodeTask(instanceId: number, planTaskId: string): Promise<boolean> {
  return (await legacyCodeTask(instanceId, planTaskId)) !== null;
}

/** Base di un compito con codice: quello registrato per un compito di prima della 3b, altrimenti il branch del lavoro aperto (null = base dell'App). */
export async function workBaseFor(instanceId: number, planTaskId: string): Promise<string | null> {
  const legacy = await legacyCodeTask(instanceId, planTaskId);
  if (legacy) return legacy.baseBranch;
  const work = await getOpenWork(instanceId);
  return work?.status === "open" ? work.branch : null;
}

/** Un compito di un ruolo che scrive codice è in coda, in corso o in attesa del nodo. */
export async function writerTaskActive(instance: TeamInstanceRow): Promise<boolean> {
  const writers = instance.roles.filter((r) => codeWrites(r.code ?? "none")).map((r) => r.key);
  if (writers.length === 0) return false;
  const [busy] = await db
    .select({ id: teamTasksTable.id })
    .from(teamTasksTable)
    .where(and(eq(teamTasksTable.instanceId, instance.id), inArray(teamTasksTable.roleKey, writers), inArray(teamTasksTable.status, ["queued", "running", "waiting_node"])))
    .limit(1);
  return busy !== undefined;
}

// --- Chiusura del lavoro, versione di prova e voce «Porta in produzione» (§15.3) ----------------------------------------

export type CloseWorkResult = "closed" | "abandoned" | "not_done" | "already" | "none";

/**
 * Chiude il lavoro aperto della squadra (dalla sorveglianza, quando non resta nulla da fare, o da `chiudi_lavoro`):
 * nessuna PR unita → `abandoned` con l'evento; altrimenti `awaiting_release` (UPDATE condizionato a `open`, una volta sola)
 * con l'evento `lavoro_finito`, poi versione di prova e voce `release` (`ensureReleaseItem`). Senza `fromLead` chiude solo se
 * nessun compito di un ruolo che scrive codice è in corso, tutti i compiti con codice del PLAN approvato sono finiti
 * (`done|blocked|failed`) e nessuna PR del lavoro è aperta.
 */
export async function closeWorkIfDone(instanceId: number, opts: { fromLead?: boolean; bulletin?: string } = {}): Promise<CloseWorkResult> {
  const work = await getOpenWork(instanceId);
  if (!work) return "none";
  if (work.status !== "open") return "already";
  const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId)).limit(1);
  if (!instance) return "none";
  // Un lavoro rimandato indietro (rifiuto o rilascio non riuscito) lo richiude solo il capo, dopo le correzioni
  if (!opts.fromLead && (work.rejectionNote !== null || !(await workFinished(instance, work.id)))) return "not_done";
  const [{ merged } = { merged: 0 }] = await db
    .select({ merged: sql<number>`count(*)::int` })
    .from(teamCodeTasksTable)
    .where(and(eq(teamCodeTasksTable.workId, work.id), eq(teamCodeTasksTable.prState, "merged")));
  const abandon = merged === 0;
  const won = await db.transaction(async (tx) => {
    const [w] = await tx
      .update(teamWorksTable)
      .set(abandon ? { status: "abandoned", finishedAt: new Date(), updatedAt: new Date() } : { status: "awaiting_release", updatedAt: new Date() })
      .where(and(eq(teamWorksTable.id, work.id), eq(teamWorksTable.status, "open")))
      .returning({ id: teamWorksTable.id });
    if (!w) return false;
    if (abandon) await emitEvent({ instanceId, type: "bloccato", bulletin: WORK_MESSAGES.nothingMerged }, tx);
    else await emitEvent({ instanceId, type: "lavoro_finito", bulletin: (opts.bulletin ?? `Lavoro ${work.number}: compiti finiti`).slice(0, 300) }, tx);
    return true;
  });
  if (!won) return "already";
  logger.info({ instanceId, work: work.number, merged }, abandon ? "Lavoro abbandonato" : "Lavoro chiuso");
  if (abandon) {
    notifyWorkChanged(instanceId);
    return "abandoned";
  }
  await ensureReleaseItem(work.id);
  notifyWorkChanged(instanceId);
  return "closed";
}

/** Nessun compito di chi scrive codice in corso, compiti con codice del PLAN approvato finiti, nessuna PR del lavoro aperta. */
async function workFinished(instance: TeamInstanceRow, workId: number): Promise<boolean> {
  const writers = instance.roles.filter((r) => codeWrites(r.code ?? "none")).map((r) => r.key);
  if (writers.length === 0) return false;
  const [busy] = await db
    .select({ id: teamTasksTable.id })
    .from(teamTasksTable)
    .where(and(eq(teamTasksTable.instanceId, instance.id), inArray(teamTasksTable.roleKey, writers), inArray(teamTasksTable.status, ["queued", "running", "waiting_node"])))
    .limit(1);
  if (busy) return false;
  const [open] = await db
    .select({ id: teamCodeTasksTable.id })
    .from(teamCodeTasksTable)
    .where(and(eq(teamCodeTasksTable.workId, workId), eq(teamCodeTasksTable.prState, "open")))
    .limit(1);
  if (open) return false;
  const approved = await getApprovedPlan(instance.id);
  if (!approved) return false;
  const current = await getPlan(instance.id);
  const status = new Map(current.tasks.map((t) => [t.id, t.status]));
  const codeTasks = approved.tasks.filter((t) => writers.includes(t.roleKey));
  return codeTasks.length > 0 && codeTasks.every((t) => ["done", "blocked", "failed"].includes(status.get(t.id) ?? "planned"));
}

/**
 * Lavoro `awaiting_release` senza voce: sposta il branch di prova dell'App alla testa del lavoro (solo se il nome è ancora
 * valido, ricontrollato qui) con l'evento `lavoro_in_prova`, poi accoda la voce `release` all'utente che ha attivato la
 * squadra. Una coda piena lascia il lavoro com'è: la sorveglianza riprova al giro dopo.
 */
export async function ensureReleaseItem(workId: number): Promise<void> {
  const [work] = await db.select().from(teamWorksTable).where(eq(teamWorksTable.id, workId)).limit(1);
  if (!work || work.status !== "awaiting_release" || work.pendingActionId !== null) return;
  const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, work.instanceId)).limit(1);
  if (!instance || instance.activatedBy === null) return;
  const repo = await workRepo(instance);
  if (!repo) return;
  const head = (await getBranchHead(repo.ref, work.branch)) ?? work.headSha ?? work.baseSha;
  // Il branch di prova non è mai il base del lavoro né il base attuale dell'App (che può essere cambiato a metà lavoro)
  const currentBase = repo.sourceBranch ?? (await getDefaultBranch(repo.ref));
  let staging =
    repo.stagingBranch !== null && checkStagingBranch(repo.stagingBranch, work.baseBranch) === null && checkStagingBranch(repo.stagingBranch, currentBase) === null
      ? { branch: repo.stagingBranch, url: repo.stagingUrl }
      : null;
  let stagingNote: string | null = staging ? null : WORK_MESSAGES.noStaging;
  if (staging) {
    try {
      // Idempotente: con il branch di prova già sulla testa del lavoro (giro ripetuto, coda piena) niente scrittura né evento
      if ((await getBranchHead(repo.ref, staging.branch)) !== head) {
        await forceUpdateRef(repo.ref, staging.branch, head);
        await emitEvent({
          instanceId: instance.id,
          type: "lavoro_in_prova",
          bulletin: `Lavoro ${work.number} in prova${staging.url ? ` su ${staging.url}` : ` sul branch ${staging.branch}`}`.slice(0, 300),
        });
      }
    } catch (err) {
      logger.warn({ instanceId: instance.id, work: work.number, errName: err instanceof Error ? err.name : "Error" }, "Branch di prova non aggiornato");
      staging = null;
      stagingNote = WORK_MESSAGES.stagingFailed;
      await emitEvent({ instanceId: instance.id, type: "bloccato", bulletin: `Lavoro ${work.number}: ${WORK_MESSAGES.stagingFailed}`.slice(0, 300) });
    }
  }
  const pulls = await db
    .select({ planTaskId: teamCodeTasksTable.planTaskId, prNumber: teamCodeTasksTable.prNumber, prUrl: teamCodeTasksTable.prUrl })
    .from(teamCodeTasksTable)
    .where(and(eq(teamCodeTasksTable.workId, work.id), eq(teamCodeTasksTable.prState, "merged")));
  const approved = await getApprovedPlan(instance.id);
  const tasks = pulls.map((p) => {
    const t = approved?.tasks.find((x) => x.id === p.planTaskId);
    return { id: p.planTaskId, title: t?.title ?? p.planTaskId, issue: t?.issue ?? null, prNumber: p.prNumber, prUrl: p.prUrl };
  });
  const detail = {
    workId: work.id,
    number: work.number,
    repo: work.repo,
    branch: work.branch,
    baseBranch: work.baseBranch,
    headSha: head,
    stagingBranch: staging?.branch ?? null,
    stagingUrl: staging?.url ?? null,
    stagingNote,
    tasks,
    review: await reviewOutcome(instance, work),
    postScripts: work.postScripts,
  };
  const queuedItem = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(teamWorksTable).where(eq(teamWorksTable.id, work.id)).for("update").limit(1);
    if (!locked || locked.status !== "awaiting_release" || locked.pendingActionId !== null) return false;
    const queued = await enqueueReleaseItem(
      { userId: instance.activatedBy!, instanceId: instance.id, recipient: work.repo, summary: `Porta in produzione il lavoro ${work.number} di ${instance.name}`, detail },
      tx,
    );
    if (!queued.ok) {
      logger.warn({ instanceId: instance.id, work: work.number }, "Voce Porta in produzione non accodata: coda piena");
      return false;
    }
    const [item] = await tx
      .select({ id: pendingActionsTable.id })
      .from(pendingActionsTable)
      .where(and(eq(pendingActionsTable.userId, instance.activatedBy!), eq(pendingActionsTable.number, queued.number)))
      .limit(1);
    await tx.update(teamWorksTable).set({ pendingActionId: item!.id, headSha: head, updatedAt: new Date() }).where(eq(teamWorksTable.id, work.id));
    return true;
  });
  if (!queuedItem) return;
  notifyWorkChanged(instance.id);
  // Collaudo della testa del lavoro: un errore non tocca la voce, già in coda. Import dinamico: il collaudo dipende da release.ts,
  // che dipende da questo modulo
  try {
    const { requestReleaseTest } = await import("../collaudo/service");
    await requestReleaseTest(work.id);
  } catch (err) {
    logger.error({ instanceId: instance.id, work: work.number, errName: err instanceof Error ? err.name : "Error" }, "Collaudo del lavoro non richiesto");
  }
}

/** Esito dell'ultima revisione del lavoro: compito finito di un ruolo con il codice in lettura, creato dopo l'apertura del lavoro. */
async function reviewOutcome(instance: TeamInstanceRow, work: TeamWork): Promise<{ roleKey: string; roleName: string; outcome: string } | null> {
  const readers = instance.roles.filter((r) => !r.isLead && (r.code ?? "none") === "read");
  if (readers.length === 0) return null;
  const [row] = await db
    .select({ roleKey: teamTasksTable.roleKey, outcome: teamTasksTable.outcome })
    .from(teamTasksTable)
    .where(
      and(
        eq(teamTasksTable.instanceId, instance.id),
        inArray(
          teamTasksTable.roleKey,
          readers.map((r) => r.key),
        ),
        eq(teamTasksTable.status, "done"),
        // Stesso orologio (default del DB) per il compito e per il lavoro
        gte(teamTasksTable.createdAt, work.createdAt),
      ),
    )
    .orderBy(sql`${teamTasksTable.finishedAt} desc`)
    .limit(1);
  if (!row) return null;
  return { roleKey: row.roleKey, roleName: readers.find((r) => r.key === row.roleKey)?.name ?? row.roleKey, outcome: (row.outcome ?? "").slice(0, 300) };
}

/** Giro della sorveglianza: chiude i lavori aperti finiti e completa quelli in attesa senza voce (al più 20 squadre attive). */
export async function sweepWorks(): Promise<void> {
  const rows = await db
    .select({ id: teamWorksTable.id, instanceId: teamWorksTable.instanceId, status: teamWorksTable.status })
    .from(teamWorksTable)
    .innerJoin(teamInstancesTable, eq(teamInstancesTable.id, teamWorksTable.instanceId))
    .where(and(eq(teamInstancesTable.status, "active"), inArray(teamWorksTable.status, ["open", "awaiting_release"])))
    .limit(20);
  for (const w of rows) {
    try {
      if (w.status === "open") await closeWorkIfDone(w.instanceId);
      else await ensureReleaseItem(w.id);
    } catch (err) {
      logger.error({ instanceId: w.instanceId, errName: err instanceof Error ? err.name : "Error" }, "Controllo del lavoro non riuscito");
    }
  }
}

// --- Viste del lavoro (capo e console) -----------------------------------------------------------------------------

export interface WorkSummary {
  numero: number;
  stato: TeamWork["status"];
  branch: string;
  prUnite: number;
  compitoInFila: string | null;
}

async function mergedCount(workId: number): Promise<number> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(teamCodeTasksTable)
    .where(and(eq(teamCodeTasksTable.workId, workId), eq(teamCodeTasksTable.prState, "merged")));
  return n;
}

/** Compito con codice in fila: PR aperta nel lavoro, altrimenti un compito di un ruolo che scrive codice in corso. */
async function queuedTask(instance: TeamInstanceRow, workId: number): Promise<string | null> {
  const [open] = await db
    .select({ id: teamCodeTasksTable.planTaskId })
    .from(teamCodeTasksTable)
    .where(and(eq(teamCodeTasksTable.workId, workId), eq(teamCodeTasksTable.prState, "open")))
    .limit(1);
  if (open) return open.id;
  const writers = instance.roles.filter((r) => codeWrites(r.code ?? "none")).map((r) => r.key);
  if (writers.length === 0) return null;
  const [busy] = await db
    .select({ id: teamTasksTable.planTaskId })
    .from(teamTasksTable)
    .where(and(eq(teamTasksTable.instanceId, instance.id), inArray(teamTasksTable.roleKey, writers), inArray(teamTasksTable.status, ["queued", "running", "waiting_node"])))
    .limit(1);
  return busy?.id ?? null;
}

/** Ultimo lavoro della squadra per `leggi_piano` (null se la squadra non ne ha mai aperto uno). */
export async function workSummary(instanceId: number): Promise<WorkSummary | null> {
  const [work] = await db.select().from(teamWorksTable).where(eq(teamWorksTable.instanceId, instanceId)).orderBy(sql`${teamWorksTable.number} desc`).limit(1);
  if (!work) return null;
  const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId)).limit(1);
  return {
    numero: work.number,
    stato: work.status,
    branch: work.branch,
    prUnite: await mergedCount(work.id),
    compitoInFila: instance && work.status === "open" ? await queuedTask(instance, work.id) : null,
  };
}

export interface WorkView {
  id: number;
  number: number;
  status: TeamWork["status"];
  repo: string;
  branch: string;
  baseBranch: string;
  headSha: string | null;
  mergedPulls: number;
  queuedTask: string | null;
  postScripts: string[];
  stagingBranch: string | null;
  stagingUrl: string | null;
  releaseActionNumber: number | null;
  releasePrNumber: number | null;
  releasePrUrl: string | null;
  rejectionNote: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Ultimi lavori della squadra (al più 20), dal più recente, per la console. */
export async function listWorks(instanceId: number, limit = 20): Promise<WorkView[]> {
  const rows = await db
    .select({ work: teamWorksTable, actionNumber: pendingActionsTable.number })
    .from(teamWorksTable)
    .leftJoin(pendingActionsTable, eq(pendingActionsTable.id, teamWorksTable.pendingActionId))
    .where(eq(teamWorksTable.instanceId, instanceId))
    .orderBy(sql`${teamWorksTable.number} desc`)
    .limit(Math.min(limit, 20));
  if (rows.length === 0) return [];
  const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId)).limit(1);
  const [app] = instance ? await db.select().from(appsTable).where(eq(appsTable.id, instance.refAppId)).limit(1) : [];
  const out: WorkView[] = [];
  for (const { work, actionNumber } of rows) {
    out.push({
      id: work.id,
      number: work.number,
      status: work.status,
      repo: work.repo,
      branch: work.branch,
      baseBranch: work.baseBranch,
      headSha: work.headSha,
      mergedPulls: await mergedCount(work.id),
      queuedTask: instance && work.status === "open" ? await queuedTask(instance, work.id) : null,
      postScripts: work.postScripts,
      stagingBranch: app?.stagingBranch ?? null,
      stagingUrl: app?.stagingUrl ?? null,
      releaseActionNumber: actionNumber ?? null,
      releasePrNumber: work.releasePrNumber,
      releasePrUrl: work.releasePrUrl,
      rejectionNote: work.rejectionNote,
      createdAt: work.createdAt.toISOString(),
      finishedAt: work.finishedAt ? work.finishedAt.toISOString() : null,
    });
  }
  return out;
}

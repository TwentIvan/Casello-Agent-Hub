import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { appsTable, db, pendingActionsTable, teamCodeTasksTable, teamInstancesTable, type PendingActionRow, type TeamCodeTaskRow } from "@workspace/db";
import { githubConfig } from "../github/config";
import { userHasInstallation } from "../github/installations";
import { logger } from "../logger";
import { decryptSecret } from "../secrets";
import { enqueueMergeItem } from "../actions/queue";
import { internalTool } from "../teams/role-tools";
import { enqueueTurnReason, notifyTurnQueued } from "../teams/turn-queue";
import type { CatalogTool, ToolResult } from "../tools/types";
import { ciState } from "./ci-state";
import { getPullDetail, listPullFiles, markReadyForReview, readCi, squashMerge, type PullDetail, type RepoRef } from "./github-git";
import { codeBranch, codeErrorMessage } from "./session";

/**
 * Merge delle PR delle squadre (spec 2026-11-14): strumento `unisci_pr` dei ruoli con `code: merge` e voce `merge` di
 * «Da confermare» per le PR che toccano migrazioni o schema. Tutti i controlli stanno qui, lato server: PR della squadra
 * aperta verso il base registrato, testa uguale all'ultimo controllo, CI verde letta dal vivo, nessun workflow, limite
 * orario per squadra. Messaggi fissi, mai testo di GitHub né token nei log.
 */

/** Merge fatti da Botcave al più in un'ora, per squadra. */
export const MAX_MERGES_PER_HOUR = 6;
const HOUR_MS = 3_600_000;
/** Una prenotazione rimasta (processo caduto prima del merge) si può riprendere dopo questo tempo. */
const RESERVATION_STALE_MS = 10 * 60_000;
/** File di migrazione elencati nella voce in coda. */
const MAX_LISTED_FILES = 50;

export const MERGE_MESSAGES = {
  badArgs: "argomenti non validi: indica compito (id del PLAN) oppure numero (della PR)",
  noPull: (what: string) => `nessuna PR aperta della squadra per ${what}`,
  notTeamBranch: "la PR non è sul branch del compito della squadra: Botcave non la unisce",
  baseChanged: "la PR non punta più al branch base del compito: Botcave non la unisce",
  teamNotActive: "la squadra non è attiva",
  access: "accesso al repository non disponibile",
  alreadyMerged: "la PR è già stata unita o chiusa",
  headMoved: "la PR è cambiata dall'ultimo controllo: aspetta l'esito della CI",
  ciPending: "CI ancora in corso: aspetta l'esito prima di unire",
  ciFailure: "CI non superata: correggi prima di unire",
  ciNone: "nessuna CI sulla PR: senza CI verde Botcave non unisce",
  workflows: "la PR modifica i workflow della CI: Botcave non la unisce, la unisce l'utente su GitHub",
  tooManyFiles: "la PR tocca troppi file per un merge automatico: la unisce l'utente su GitHub",
  tooManyMerges: `limite di merge raggiunto (al massimo ${MAX_MERGES_PER_HOUR} all'ora per squadra): riprova più tardi`,
  inProgress: "merge già in corso per questa PR",
  queued: (n: number, pr: number) =>
    `la PR #${pr} tocca migrazioni o schema del DB: è in «Da confermare» (voce n. ${n}). L'utente applica l'SQL su Neon e approva: segnalaglielo con segnala`,
  alreadyQueued: (n: number, pr: number) => `la PR #${pr} è già in «Da confermare» (voce n. ${n}): aspetta la decisione dell'utente`,
  merged: (pr: number, base: string) => `PR #${pr} unita con squash in ${base}: l'esito arriva al capo con la sorveglianza (pr_closed)`,
  internal: "errore interno nel merge della PR",
  /** Esito della voce in coda. */
  done: (pr: number) => `PR #${pr} unita`,
  itemChanged: "la PR è cambiata dopo la richiesta: chiedi un nuovo merge",
  summary: (pr: number, task: string) => `Unisci la PR #${pr} (compito ${task}): applica prima le migrazioni su Neon`,
} as const;

/** Percorsi che un merge automatico non tocca mai (workflow) e quelli che passano dall'utente (migrazioni e schema). */
const WORKFLOW_PREFIXES = [".github/workflows/"];
const MIGRATION_PREFIXES = ["docs/migrations/", "lib/db/src/schema/"];
const MIGRATION_FILES = ["docs/schema-casello.sql"];

export function classifyPullFiles(files: string[]): { workflows: string[]; migrations: string[] } {
  const unique = [...new Set(files)];
  return {
    workflows: unique.filter((f) => WORKFLOW_PREFIXES.some((p) => f.startsWith(p))),
    migrations: unique.filter((f) => MIGRATION_FILES.includes(f) || MIGRATION_PREFIXES.some((p) => f.startsWith(p))),
  };
}

export type MergeTarget = { compito: string } | { numero: number };

export function parseMergeArgs(args: Record<string, unknown>): MergeTarget | null {
  const keys = Object.keys(args ?? {});
  if (keys.some((k) => k !== "compito" && k !== "numero")) return null;
  const compito = args["compito"];
  const numero = args["numero"];
  if (compito !== undefined && numero !== undefined) return null;
  if (typeof compito === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(compito)) return { compito };
  if (Number.isSafeInteger(numero) && (numero as number) > 0) return { numero: numero as number };
  return null;
}

export const MERGE_TOOL: CatalogTool = internalTool(
  "unisci_pr",
  "Unisce con squash la PR di un compito della squadra nel branch base, solo con la CI verde sull'ultima testa controllata. Una PR che tocca migrazioni o schema del DB va in «Da confermare» per l'utente; i workflow della CI non si uniscono mai.",
  {
    type: "object",
    properties: {
      compito: { type: "string", description: "Id del compito del PLAN (es. t3)" },
      numero: { type: "integer", minimum: 1, description: "Numero della PR (in alternativa a compito)" },
    },
    additionalProperties: false,
  },
);

class MergeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeRefused";
  }
}

interface Context {
  instance: { id: number; name: string; status: string; activatedBy: number | null };
  row: TeamCodeTaskRow;
  repo: RepoRef;
}

async function loadContext(instanceId: number, find: (t: typeof teamCodeTasksTable) => ReturnType<typeof eq>, what: string): Promise<Context> {
  const [instance] = await db
    .select({ id: teamInstancesTable.id, name: teamInstancesTable.name, status: teamInstancesTable.status, activatedBy: teamInstancesTable.activatedBy, refAppId: teamInstancesTable.refAppId })
    .from(teamInstancesTable)
    .where(eq(teamInstancesTable.id, instanceId))
    .limit(1);
  if (!instance || instance.status !== "active") throw new MergeRefused(MERGE_MESSAGES.teamNotActive);
  const [row] = await db
    .select()
    .from(teamCodeTasksTable)
    .where(and(eq(teamCodeTasksTable.instanceId, instanceId), find(teamCodeTasksTable)))
    .limit(1);
  if (!row || row.prNumber === null) throw new MergeRefused(MERGE_MESSAGES.noPull(what));
  if (row.prState !== "open") throw new MergeRefused(MERGE_MESSAGES.alreadyMerged);
  // Il branch si ricalcola: una riga con un branch diverso non è un compito di questa squadra
  if (row.branch !== codeBranch(instanceId, row.planTaskId)) throw new MergeRefused(MERGE_MESSAGES.notTeamBranch);
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, instance.refAppId)).limit(1);
  const cfg = githubConfig();
  if (!app || !cfg || app.sourceType !== "github" || !app.sourceRepo || app.sourceInstallationId === null || app.sourceRepo !== row.repo) {
    throw new MergeRefused(MERGE_MESSAGES.access);
  }
  if (instance.activatedBy === null || !(await userHasInstallation(instance.activatedBy, app.sourceInstallationId))) {
    throw new MergeRefused(MERGE_MESSAGES.access);
  }
  return { instance, row, repo: { cfg, installationId: app.sourceInstallationId, repo: app.sourceRepo } };
}

/** PR e CI dal vivo: PR aperta sul branch e verso il base del compito, testa attesa, CI verde. */
async function checkPull(ctx: Context, expectedHead: string | null): Promise<PullDetail> {
  const { row, repo } = ctx;
  const pull = await getPullDetail(repo, row.prNumber!);
  if (pull.state !== "open") throw new MergeRefused(MERGE_MESSAGES.alreadyMerged);
  if (pull.headRef !== row.branch) throw new MergeRefused(MERGE_MESSAGES.notTeamBranch);
  if (pull.baseRef !== row.baseBranch) throw new MergeRefused(MERGE_MESSAGES.baseChanged);
  if (pull.headSha !== (expectedHead ?? row.headSha)) throw new MergeRefused(expectedHead ? MERGE_MESSAGES.itemChanged : MERGE_MESSAGES.headMoved);
  const since = row.lastCommitAt ? Date.now() - row.lastCommitAt.getTime() : Number.POSITIVE_INFINITY;
  const state = ciState(await readCi(repo, pull.headSha), since);
  if (state === "pending") throw new MergeRefused(MERGE_MESSAGES.ciPending);
  if (state === "failure") throw new MergeRefused(MERGE_MESSAGES.ciFailure);
  if (state === "none") throw new MergeRefused(MERGE_MESSAGES.ciNone);
  return pull;
}

/**
 * Prenota il merge sulla riga (una PR non si unisce due volte in parallelo) e, per lo strumento, controlla il limite
 * orario della squadra, con la riga della squadra bloccata.
 */
async function reserve(ctx: Context, withLimit: boolean): Promise<void> {
  const t = teamCodeTasksTable;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from team_instances where id = ${ctx.instance.id} for update`);
    if (withLimit) {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(and(eq(t.instanceId, ctx.instance.id), gt(t.botcaveMergedAt, new Date(Date.now() - HOUR_MS))));
      if (n >= MAX_MERGES_PER_HOUR) throw new MergeRefused(MERGE_MESSAGES.tooManyMerges);
    }
    const [won] = await tx
      .update(t)
      .set({ botcaveMergedAt: new Date() })
      .where(and(eq(t.id, ctx.row.id), or(isNull(t.botcaveMergedAt), lt(t.botcaveMergedAt, new Date(Date.now() - RESERVATION_STALE_MS)))))
      .returning({ id: t.id });
    if (!won) throw new MergeRefused(MERGE_MESSAGES.inProgress);
  });
}

async function release(rowId: number): Promise<void> {
  await db.update(teamCodeTasksTable).set({ botcaveMergedAt: null }).where(eq(teamCodeTasksTable.id, rowId));
}

/** Esce dalla bozza e unisce con squash sulla testa controllata; un errore toglie la prenotazione. */
async function doMerge(ctx: Context, pull: PullDetail): Promise<void> {
  try {
    if (pull.draft) await markReadyForReview(ctx.repo, pull.nodeId);
    const title = `${pull.title || `Compito ${ctx.row.planTaskId}`} (#${pull.number})`.slice(0, 250);
    const merged = await squashMerge(ctx.repo, pull.number, { sha: pull.headSha, title });
    logger.info(
      { instanceId: ctx.instance.id, planTaskId: ctx.row.planTaskId, pr: pull.number, head: pull.headSha.slice(0, 7), sha: merged.sha.slice(0, 7) },
      "PR della squadra unita da Botcave",
    );
  } catch (err) {
    await release(ctx.row.id).catch((e: unknown) =>
      logger.error({ taskCodeId: ctx.row.id, errName: e instanceof Error ? e.name : "Error" }, "Prenotazione del merge non tolta"),
    );
    throw err;
  }
}

function refusal(err: unknown): string | null {
  if (err instanceof MergeRefused) return err.message;
  return codeErrorMessage(err);
}

/** Voce `merge` già aperta per la stessa PR (una sola alla volta). */
async function openMergeItem(userId: number, instanceId: number, taskCodeId: number): Promise<number | null> {
  const [row] = await db
    .select({ number: pendingActionsTable.number })
    .from(pendingActionsTable)
    .where(
      and(
        eq(pendingActionsTable.userId, userId),
        eq(pendingActionsTable.kind, "merge"),
        eq(pendingActionsTable.teamInstanceId, instanceId),
        eq(pendingActionsTable.status, "pending"),
        sql`(${pendingActionsTable.argsPublic} ->> 'taskCodeId')::int = ${taskCodeId}`,
      ),
    )
    .limit(1);
  return row?.number ?? null;
}

/** Strumento `unisci_pr` (ruoli con `code: merge`, capo compreso): `{ok:false}` con messaggi fissi, mai eccezioni. */
export async function mergeTeamPull(instanceId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const target = parseMergeArgs(args);
  if (!target) return { ok: false, content: MERGE_MESSAGES.badArgs };
  try {
    const ctx =
      "compito" in target
        ? await loadContext(instanceId, (t) => eq(t.planTaskId, target.compito), `il compito ${target.compito}`)
        : await loadContext(instanceId, (t) => eq(t.prNumber, target.numero), `la PR #${target.numero}`);
    const pull = await checkPull(ctx, null);
    const files = await listPullFiles(ctx.repo, pull.number);
    if (files === null) return { ok: false, content: MERGE_MESSAGES.tooManyFiles };
    const { workflows, migrations } = classifyPullFiles(files);
    if (workflows.length > 0) return { ok: false, content: MERGE_MESSAGES.workflows };
    if (migrations.length > 0) {
      const userId = ctx.instance.activatedBy!;
      const existing = await openMergeItem(userId, instanceId, ctx.row.id);
      if (existing !== null) return { ok: false, content: MERGE_MESSAGES.alreadyQueued(existing, pull.number) };
      const queued = await enqueueMergeItem({
        userId,
        instanceId,
        recipient: ctx.repo.repo,
        summary: MERGE_MESSAGES.summary(pull.number, ctx.row.planTaskId),
        detail: {
          taskCodeId: ctx.row.id,
          planTaskId: ctx.row.planTaskId,
          repo: ctx.repo.repo,
          prNumber: pull.number,
          prUrl: pull.url,
          headSha: pull.headSha,
          baseBranch: ctx.row.baseBranch,
          files: migrations.slice(0, MAX_LISTED_FILES),
          moreFiles: Math.max(0, migrations.length - MAX_LISTED_FILES),
        },
      });
      if (!queued.ok) return { ok: false, content: queued.message };
      logger.info({ instanceId, planTaskId: ctx.row.planTaskId, pr: pull.number, files: migrations.length }, "Merge con migrazioni messo in coda");
      return { ok: false, content: MERGE_MESSAGES.queued(queued.number, pull.number) };
    }
    await reserve(ctx, true);
    await doMerge(ctx, pull);
    return { ok: true, content: MERGE_MESSAGES.merged(pull.number, ctx.row.baseBranch) };
  } catch (err) {
    const msg = refusal(err);
    if (msg !== null) return { ok: false, content: msg };
    logger.error({ instanceId, errName: err instanceof Error ? err.name : "Error" }, "Merge della PR non riuscito");
    return { ok: false, content: MERGE_MESSAGES.internal };
  }
}

export type MergeDecision = { ok: true; action: PendingActionRow } | { ok: false; status: 404 | 409 | 500; message: string };

async function finishItem(id: number, set: { status: "done" | "failed"; result?: string; errorMessage?: string }): Promise<PendingActionRow | undefined> {
  const [row] = await db.update(pendingActionsTable).set({ ...set, finishedAt: new Date() }).where(eq(pendingActionsTable.id, id)).returning();
  return row;
}

/**
 * Approvazione di una voce `merge`: stessi controlli dello strumento tranne le migrazioni (l'utente le ha applicate), testa
 * uguale a quella della voce, niente limite orario (decide l'utente). Esito sulla voce; un fallimento torna al capo.
 */
export async function approveMerge(userId: number, action: PendingActionRow): Promise<MergeDecision> {
  const [claimed] = await db
    .update(pendingActionsTable)
    .set({ status: "executing", decidedBy: userId, decidedAt: new Date() })
    .where(and(eq(pendingActionsTable.id, action.id), eq(pendingActionsTable.status, "pending")))
    .returning();
  if (!claimed) return { ok: false, status: 409, message: "azione già decisa" };
  let detail: { taskCodeId?: unknown; headSha?: unknown };
  try {
    detail = JSON.parse(decryptSecret(action.argsEnc)) as typeof detail;
  } catch {
    detail = {};
  }
  const instanceId = action.teamInstanceId;
  const taskCodeId = typeof detail.taskCodeId === "number" ? detail.taskCodeId : null;
  const headSha = typeof detail.headSha === "string" ? detail.headSha : null;
  let failure: string;
  let prNumber: number | null = null;
  try {
    if (instanceId === null || taskCodeId === null || headSha === null) throw new MergeRefused(MERGE_MESSAGES.itemChanged);
    const ctx = await loadContext(instanceId, (t) => eq(t.id, taskCodeId), "questa voce");
    prNumber = ctx.row.prNumber;
    const pull = await checkPull(ctx, headSha);
    const files = await listPullFiles(ctx.repo, pull.number);
    if (files === null) throw new MergeRefused(MERGE_MESSAGES.tooManyFiles);
    if (classifyPullFiles(files).workflows.length > 0) throw new MergeRefused(MERGE_MESSAGES.workflows);
    await reserve(ctx, false);
    await doMerge(ctx, pull);
    const row = await finishItem(action.id, { status: "done", result: MERGE_MESSAGES.done(pull.number) });
    return row ? { ok: true, action: row } : { ok: false, status: 404, message: "azione non trovata" };
  } catch (err) {
    const msg = refusal(err);
    if (msg === null) logger.error({ actionId: action.id, errName: err instanceof Error ? err.name : "Error" }, "Merge della voce in coda non riuscito");
    failure = msg ?? MERGE_MESSAGES.internal;
  }
  const row = await finishItem(action.id, { status: "failed", errorMessage: failure }).catch(() => undefined);
  if (instanceId !== null && taskCodeId !== null) {
    try {
      await enqueueTurnReason(instanceId, { type: "merge_failed", taskCodeId, message: failure });
      notifyTurnQueued(instanceId);
    } catch (err) {
      logger.error({ instanceId, pr: prNumber, errName: err instanceof Error ? err.name : "Error" }, "Motivo del merge non riuscito non accodato");
    }
  }
  return row ? { ok: true, action: row } : { ok: false, status: 500, message: "errore interno: esito dell'azione non registrato" };
}

/** Rifiuto di una voce `merge`: il capo lo sa al turno dopo (motivo `decision`). */
export async function notifyMergeRejected(action: PendingActionRow): Promise<void> {
  if (action.kind !== "merge" || action.teamInstanceId === null) return;
  await enqueueTurnReason(action.teamInstanceId, { type: "decision", number: action.number, outcome: "rejected", note: action.decisionNote });
  notifyTurnQueued(action.teamInstanceId);
}

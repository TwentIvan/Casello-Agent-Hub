// Lavoro su branch unico delle squadre con codice (spec 2026-11-16-botcave-evoluzione-automatica §15.2): il primo compito con
// codice apre il lavoro e il suo branch dalla testa del base dell'App; i compiti con codice partono dal branch del lavoro e
// vanno in fila (uno alla volta, il successivo dopo il merge della PR del precedente). Log: id, numeri e sha a 7.

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  appsTable,
  teamCodeTasksTable,
  teamTasksTable,
  teamWorksTable,
  type TeamInstanceRow,
  type TeamWork,
} from "@workspace/db";
import { logger } from "../logger";
import { githubConfig } from "../github/config";
import { createBranch, getBranchHead, getDefaultBranch, type RepoRef } from "../code-writer/github-git";
import { isUniqueViolation } from "../pg-errors";
import { codeWrites } from "./manifest";

export const WORK_MESSAGES = {
  queueBusy: "un compito con codice è già in corso nel lavoro: aspetta che la sua PR sia unita",
  noCi: "nessuna CI sul branch: aggiungi un workflow che giri sui branch botcave/**",
  alreadyClosed: "lavoro già chiuso: aspetta la decisione su Porta in produzione",
  nothingMerged: "nessun compito unito nel lavoro",
  workPull: "le PR del lavoro le unisce Botcave quando la CI è verde",
  noStaging: "nessuna versione di prova configurata per l'App",
  noAccess: "accesso al repository non disponibile",
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
export async function codeQueueBlock(instance: TeamInstanceRow, workId: number, tx: Executor): Promise<string | null> {
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
    .where(and(eq(teamCodeTasksTable.workId, workId), eq(teamCodeTasksTable.prState, "open")))
    .limit(1);
  return open ? WORK_MESSAGES.queueBusy : null;
}

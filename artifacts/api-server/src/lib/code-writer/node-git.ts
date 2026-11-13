import { eq } from "drizzle-orm";
import { appsTable, db, teamInstancesTable, type TeamInstanceRow, type TeamTaskRow } from "@workspace/db";
import { githubConfig } from "../github/config";
import { logger } from "../logger";
import type { NodeReport, TaskPackage } from "../nodes/protocol";
import { InstanceRoleSchema } from "../teams/manifest";
import { getPlan } from "../teams/plan";
import { upsertCodeTask } from "./code-tasks";
import { GithubError } from "../github/app";
import { CODE_WRITE_MESSAGES, CodeWriteError } from "./messages";
import { createDraftPull, findOpenPull, getBranchHead, getDefaultBranch, type PullInfo, type RepoRef } from "./github-git";
import { findCredential } from "./secrets-check";
import { codeBranch } from "./session";

/**
 * Compiti dei ruoli `node` con codice: il nodo lavora in locale con Git e `gh`, quindi Botcave non scrive nulla ma
 * consegna la convenzione (sezione «Git» delle istruzioni) e, a compito riferito `done`, cerca la PR del branch
 * per sorvegliarla come quelle dei compiti cloud.
 */

type NodeTaskGit = NonNullable<TaskPackage["git"]>;

const errName = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/** Sezione «Git» aggiunta in fondo alle istruzioni del compito (il nodo le scrive in `casello-compito.md`). */
export function nodeGitSection(input: { repo: string; baseBranch: string; branch: string; issue: number | null }): string {
  const lines = [
    "## Git",
    "",
    `Sei già sul branch \`${input.branch}\` in una copia del repository \`${input.repo}\` preparata da Botcave, partita da \`${input.baseBranch}\` (o dal lavoro già pubblicato su questo branch).`,
    "Lavora qui e fai commit piccoli e coerenti. Non fare push, non aprire PR, non cambiare branch e non toccare altri branch: alla fine del compito Botcave pubblica il branch e apre la PR in bozza.",
    "Riferisci `done` quando i commit sono pronti, oppure `blocked` col motivo.",
  ];
  if (input.issue !== null) lines.push("", `Issue: #${input.issue}`);
  return lines.join("\n");
}

/** Repository dell'App di riferimento: serve `source_repo`; il client GitHub solo con installazione e configurazione. */
export async function gitContext(instance: TeamInstanceRow): Promise<{ sourceRepo: string; sourceBranch: string | null; ref: RepoRef | null } | null> {
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, instance.refAppId)).limit(1);
  if (!app || !app.sourceRepo) return null;
  const cfg = githubConfig();
  const ref: RepoRef | null =
    cfg && app.sourceType === "github" && app.sourceInstallationId !== null
      ? { cfg, installationId: app.sourceInstallationId, repo: app.sourceRepo }
      : null;
  return { sourceRepo: app.sourceRepo, sourceBranch: app.sourceBranch, ref };
}

/**
 * Repository non accessibile in modo duraturo (installazione rimossa o senza accesso, permesso non accettato, App senza
 * installazione né branch): il claim chiude il compito `blocked` invece di rimetterlo in attesa.
 */
export class NodeGitAccessError extends Error {
  constructor() {
    super("accesso al repository non disponibile");
    this.name = "NodeGitAccessError";
  }
}

/** Errore di GitHub che non passa riprovando: accesso perso o permesso mancante (gli altri sono temporanei). */
function isPermanentGithubError(err: unknown): boolean {
  if (err instanceof GithubError) return err.message === CODE_WRITE_MESSAGES.noAccess;
  return err instanceof CodeWriteError && (err.message === CODE_WRITE_MESSAGES.noAccess || err.status === 403 || err.status === 422);
}

/**
 * Campo `git` del pacchetto e istruzioni con la sezione Git per un compito `node` con codice in scrittura; null se
 * l'App non ha un repository. Branch base non leggibile: `NodeGitAccessError` se l'accesso manca (il claim chiude il
 * compito `blocked`), altrimenti l'errore temporaneo (il claim lo rimette in attesa e passa al successivo).
 */
export async function nodeGitContext(
  instance: TeamInstanceRow,
  task: TeamTaskRow,
  issue: number | null,
): Promise<{ git: NodeTaskGit; instructions: string } | null> {
  const ctx = await gitContext(instance);
  if (!ctx) return null;
  let baseBranch = ctx.sourceBranch;
  if (baseBranch === null) {
    if (!ctx.ref) throw new NodeGitAccessError();
    try {
      baseBranch = await getDefaultBranch(ctx.ref);
    } catch (err) {
      throw isPermanentGithubError(err) ? new NodeGitAccessError() : err;
    }
  }
  const branch = codeBranch(instance.id, task.planTaskId);
  const git: NodeTaskGit = { repo: ctx.sourceRepo, baseBranch, branch, issue };
  return { git, instructions: `${task.instructions}\n\n${nodeGitSection(git)}` };
}

/** Corpo della PR aperta da Botcave: «Closes #n», esito, piè di pagina; con una credenziale nell'esito, solo il piè di pagina. */
export function nodePullBody(input: { issue: number | null; outcome: string; teamName: string; planTaskId: string }): string {
  const footer = `Botcave · squadra ${input.teamName} · compito ${input.planTaskId}`;
  const parts: string[] = [];
  if (input.issue !== null) parts.push(`Closes #${input.issue}`);
  if (input.outcome.trim()) parts.push(input.outcome.trim());
  parts.push(footer);
  const body = parts.join("\n\n");
  return findCredential(body) ? footer : body;
}

/**
 * Compito `node` riferito `done` con ruolo `code = write`: adotta la PR aperta sul branch del compito oppure, se il nodo
 * ha pubblicato il branch (`git.pushed`) e questo esiste su GitHub, la apre in bozza; poi crea o aggiorna la riga di
 * `team_code_tasks` (CI in attesa), così la sorveglianza la segue. Con errori di GitHub: niente, solo il log. Non solleva mai.
 */
export async function adoptNodePull(task: TeamTaskRow, report: { git?: NodeReport["git"]; outcome: string }): Promise<void> {
  try {
    const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, task.instanceId)).limit(1);
    if (!instance) return;
    const role = InstanceRoleSchema.array().parse(instance.roles).find((r) => r.key === task.roleKey);
    if (!role || role.code !== "write") return;
    const ctx = await gitContext(instance);
    if (!ctx?.ref) return;
    const branch = codeBranch(instance.id, task.planTaskId);
    let pull: PullInfo | null = await findOpenPull(ctx.ref, branch);
    const baseBranch = ctx.sourceBranch ?? (await getDefaultBranch(ctx.ref));
    if (!pull && report.git?.pushed === true && (await getBranchHead(ctx.ref, branch)) !== null) {
      const planTask = (await getPlan(instance.id)).tasks.find((t) => t.id === task.planTaskId);
      const title = (planTask?.title ?? "").trim().slice(0, 200);
      const issue = planTask?.issue ?? null;
      pull = await createDraftPull(ctx.ref, {
        head: branch,
        base: baseBranch,
        title: title && !findCredential(title) ? title : `Compito ${task.planTaskId}`,
        body: nodePullBody({ issue, outcome: report.outcome, teamName: instance.name, planTaskId: task.planTaskId }),
      });
    }
    if (!pull) return;
    await upsertCodeTask({
      instanceId: instance.id,
      planTaskId: task.planTaskId,
      repo: ctx.sourceRepo,
      branch,
      baseBranch,
      headSha: pull.headSha,
      pr: { number: pull.number, url: pull.url },
      committedAt: new Date(),
    });
  } catch (err) {
    logger.warn({ instanceId: task.instanceId, taskId: task.id, errName: errName(err) }, "PR del compito node non aperta né adottata");
  }
}

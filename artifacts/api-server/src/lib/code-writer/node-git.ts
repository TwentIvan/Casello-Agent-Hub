import { eq } from "drizzle-orm";
import { appsTable, db, teamInstancesTable, type TeamInstanceRow, type TeamTaskRow } from "@workspace/db";
import { githubConfig } from "../github/config";
import { logger } from "../logger";
import type { TaskPackage } from "../nodes/protocol";
import { InstanceRoleSchema } from "../teams/manifest";
import { getPlan } from "../teams/plan";
import { upsertCodeTask } from "./code-tasks";
import { findOpenPull, getDefaultBranch, type RepoRef } from "./github-git";
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
 * Campo `git` del pacchetto e istruzioni con la sezione Git per un compito `node` con codice in scrittura; null se
 * l'App non ha un repository. Lancia se il branch base non si legge: il claim rimette il compito in attesa.
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
    if (!ctx.ref) throw new Error("branch base non leggibile");
    baseBranch = await getDefaultBranch(ctx.ref);
  }
  const branch = codeBranch(instance.id, task.planTaskId);
  const git: NodeTaskGit = { repo: ctx.sourceRepo, baseBranch, branch, issue };
  return { git, instructions: `${task.instructions}\n\n${nodeGitSection(git)}` };
}

/**
 * Compito `node` riferito `done` con ruolo `code = write`: se sul branch del compito c'è una PR aperta crea o aggiorna
 * la riga di `team_code_tasks` (CI in attesa), così la sorveglianza la segue. Senza PR o con errori di GitHub: niente,
 * solo il log. Non solleva mai.
 */
export async function adoptNodePull(task: TeamTaskRow): Promise<void> {
  try {
    const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, task.instanceId)).limit(1);
    if (!instance) return;
    const role = InstanceRoleSchema.array().parse(instance.roles).find((r) => r.key === task.roleKey);
    if (!role || role.code !== "write") return;
    const ctx = await gitContext(instance);
    if (!ctx?.ref) return;
    const branch = codeBranch(instance.id, task.planTaskId);
    const pull = await findOpenPull(ctx.ref, branch);
    if (!pull) return;
    const baseBranch = ctx.sourceBranch ?? (await getDefaultBranch(ctx.ref));
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
    logger.warn({ instanceId: task.instanceId, taskId: task.id, errName: errName(err) }, "PR del compito node non adottata");
  }
}

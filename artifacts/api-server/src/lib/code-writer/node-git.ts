import { eq } from "drizzle-orm";
import { appsTable, db, teamInstancesTable, type TeamInstanceRow, type TeamTaskRow } from "@workspace/db";
import { githubConfig } from "../github/config";
import { logger } from "../logger";
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

const errName = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/** Sezione «Git» aggiunta in fondo alle istruzioni del compito (il nodo le scrive in `casello-compito.md`). */
export function nodeGitSection(input: { repo: string; baseBranch: string | null; branch: string; issue: number | null }): string {
  const base = input.baseBranch ?? "il branch predefinito del repository";
  const baseFlag = input.baseBranch ?? "<branch predefinito>";
  const lines = [
    "## Git",
    "",
    `- Repository: ${input.repo}`,
    `- Branch base: ${base}`,
    `- Branch del compito: ${input.branch}`,
  ];
  if (input.issue !== null) lines.push(`- Issue: #${input.issue}`);
  lines.push(
    "",
    `Lavora solo sul branch ${input.branch}, partendo da ${base}: crealo se non esiste. Non fare merge e non toccare altri branch.`,
    "Fai commit piccoli e coerenti, poi pubblica il branch.",
    `Quando hai finito apri la PR in bozza, una sola volta: \`gh pr create --draft --base ${baseFlag} --head ${input.branch}\``,
    "Riferisci `done` con il numero della PR, oppure `blocked` col motivo.",
  );
  return lines.join("\n");
}

/** Repository dell'App di riferimento: serve `source_repo`; il client GitHub solo con installazione e configurazione. */
async function gitContext(instance: TeamInstanceRow): Promise<{ sourceRepo: string; sourceBranch: string | null; ref: RepoRef | null } | null> {
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, instance.refAppId)).limit(1);
  if (!app || !app.sourceRepo) return null;
  const cfg = githubConfig();
  const ref: RepoRef | null =
    cfg && app.sourceType === "github" && app.sourceInstallationId !== null
      ? { cfg, installationId: app.sourceInstallationId, repo: app.sourceRepo }
      : null;
  return { sourceRepo: app.sourceRepo, sourceBranch: app.sourceBranch, ref };
}

/** Istruzioni del compito con la sezione Git, o invariate se l'App non ha un repository. */
export async function instructionsWithGit(instance: TeamInstanceRow, task: TeamTaskRow, issue: number | null): Promise<string> {
  const ctx = await gitContext(instance);
  if (!ctx) return task.instructions;
  let baseBranch = ctx.sourceBranch;
  if (baseBranch === null && ctx.ref) {
    try {
      baseBranch = await getDefaultBranch(ctx.ref);
    } catch (err) {
      logger.warn({ instanceId: instance.id, taskId: task.id, errName: errName(err) }, "Branch predefinito non leggibile per la sezione Git");
    }
  }
  const section = nodeGitSection({ repo: ctx.sourceRepo, baseBranch, branch: codeBranch(instance.id, task.planTaskId), issue });
  return `${task.instructions}\n\n${section}`;
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

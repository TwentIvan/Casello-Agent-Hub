import { and, eq, sql } from "drizzle-orm";
import { db, teamCodeTasksTable, teamWorksTable, type TeamCodeTaskRow } from "@workspace/db";

/**
 * Accesso a `team_code_tasks`: una riga per compito del PLAN con codice (branch, PR, stato della CI).
 * Si crea al primo commit o quando si trova la PR; le riesecuzioni dello stesso compito la ritrovano.
 */

export interface UpsertCodeTaskInput {
  instanceId: number;
  planTaskId: string;
  repo: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  /** PR del branch: `pr_state = open`; la CI torna `pending` se la PR è nuova o diversa da quella registrata. */
  pr?: { number: number; url: string };
  /** Un commit appena scritto: `last_commit_at`, CI di nuovo `pending` se c'è una PR, avviso di attesa azzerato. */
  committedAt?: Date;
}

export async function upsertCodeTask(input: UpsertCodeTaskInput): Promise<TeamCodeTaskRow> {
  const t = teamCodeTasksTable;
  const now = new Date();
  // Lavoro su branch unico: la PR che punta al branch di un lavoro della squadra ne fa parte (null = PR verso il base)
  const workId = sql`(select ${teamWorksTable.id} from ${teamWorksTable} where ${teamWorksTable.instanceId} = ${input.instanceId} and ${teamWorksTable.branch} = ${input.baseBranch} order by ${teamWorksTable.id} desc limit 1)`;
  const set: Record<string, unknown> = {
    workId,
    repo: input.repo,
    branch: input.branch,
    baseBranch: input.baseBranch,
    headSha: input.headSha,
    updatedAt: now,
  };
  if (input.pr) {
    set["prNumber"] = input.pr.number;
    set["prUrl"] = input.pr.url;
    set["prState"] = "open";
    set["ciState"] = sql`CASE WHEN ${t.prNumber} = ${input.pr.number} AND ${t.prState} = 'open' AND ${t.ciState} IS NOT NULL THEN ${t.ciState} ELSE 'pending'::code_ci_state END`;
  }
  if (input.committedAt) {
    set["lastCommitAt"] = input.committedAt;
    set["ciPendingNotified"] = false;
    // Un commit nuovo su una PR aperta rimette la CI in attesa
    if (input.pr) set["ciState"] = "pending";
    else set["ciState"] = sql`CASE WHEN ${t.prNumber} IS NOT NULL THEN 'pending'::code_ci_state ELSE ${t.ciState} END`;
  }
  const [row] = await db
    .insert(t)
    .values({
      instanceId: input.instanceId,
      planTaskId: input.planTaskId,
      repo: input.repo,
      branch: input.branch,
      baseBranch: input.baseBranch,
      headSha: input.headSha,
      workId,
      ...(input.pr ? { prNumber: input.pr.number, prUrl: input.pr.url, prState: "open" as const, ciState: "pending" as const } : {}),
      ...(input.committedAt ? { lastCommitAt: input.committedAt } : {}),
    })
    .onConflictDoUpdate({ target: [t.instanceId, t.planTaskId], set })
    .returning();
  return row!;
}

export async function getCodeTask(instanceId: number, planTaskId: string): Promise<TeamCodeTaskRow | null> {
  const [row] = await db
    .select()
    .from(teamCodeTasksTable)
    .where(and(eq(teamCodeTasksTable.instanceId, instanceId), eq(teamCodeTasksTable.planTaskId, planTaskId)));
  return row ?? null;
}

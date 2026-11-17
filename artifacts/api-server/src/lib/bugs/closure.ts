import { and, eq } from "drizzle-orm";
import { bugReportsTable, db, teamInstancesTable } from "@workspace/db";
import { getPlan } from "../teams/plan";
import { BUG_MESSAGES } from "./messages";
import { setStatus } from "./reports";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Tx | typeof db;

/**
 * PR di un compito della squadra per i bug unita: le segnalazioni `in_progress` della squadra la cui issue è quella
 * del compito diventano `fixed` (frase fissa, link alla PR). Va chiamata nella transazione che ha vinto l'UPDATE
 * condizionato della sorveglianza, così la chiusura avviene una volta sola. Risponde quante ne ha chiuse.
 */
export async function closeBugsForMergedPull(
  tx: Executor,
  input: { instanceId: number; planTaskId: string; prUrl: string | null },
): Promise<number> {
  const [team] = await tx
    .select({ bugTeam: teamInstancesTable.bugTeam })
    .from(teamInstancesTable)
    .where(eq(teamInstancesTable.id, input.instanceId));
  if (!team?.bugTeam) return 0;

  const plan = await getPlan(input.instanceId, tx);
  const issue = plan.tasks.find((t) => t.id === input.planTaskId)?.issue;
  if (!issue) return 0;

  const reports = await tx
    .select({ id: bugReportsTable.id })
    .from(bugReportsTable)
    .where(
      and(
        eq(bugReportsTable.teamInstanceId, input.instanceId),
        eq(bugReportsTable.issueNumber, issue),
        eq(bugReportsTable.status, "in_progress"),
      ),
    );
  let closed = 0;
  for (const r of reports) {
    const row = await setStatus(tx, r.id, ["in_progress"], "fixed", {
      publicMessage: BUG_MESSAGES.fixedMessage,
      prUrl: input.prUrl,
    });
    if (row) closed += 1;
  }
  return closed;
}

// Stato per agente (issue #108): in lavoro, in attesa dell'utente, fermo. Si ricava dalle run in coda o in corso,
// dalle run figlie ancora aperte (segnalazioni al Responsabile) e dalle voci di «Da confermare» dell'utente.
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, pendingActionsTable, runsTable } from "@workspace/db";

export type AgentActivityState = "working" | "waiting_user" | "idle";

export type AgentActivity = {
  agentId: number;
  state: AgentActivityState;
  /** Run `running` dell'agente. */
  runningRuns: number;
  /** Run `pending` (in coda) dell'agente. */
  pendingRuns: number;
  /** Run in attesa dell'esito di un'azione dal client (tool `ui`). */
  awaitingClientRuns: number;
  /** Run figlie ancora aperte nate da run dell'agente (es. segnalazione al Responsabile). */
  activeChildRuns: number;
  /** Voci `pending` di «Da confermare» dell'utente nate da run dell'agente. */
  pendingActions: number;
};

type Counts = Omit<AgentActivity, "agentId" | "state">;

const ACTIVE_STATUSES = ["pending", "running", "awaiting_client"] as const;

/**
 * Stato dai conteggi: l'utente prima di tutto (una run aspetta il client o una voce aspetta la sua decisione),
 * poi il lavoro in corso o in coda (anche delle run figlie), altrimenti fermo.
 */
export function agentState(c: Counts): AgentActivityState {
  if (c.awaitingClientRuns > 0 || c.pendingActions > 0) return "waiting_user";
  if (c.runningRuns > 0 || c.pendingRuns > 0 || c.activeChildRuns > 0) return "working";
  return "idle";
}

const emptyCounts = (): Counts => ({
  runningRuns: 0,
  pendingRuns: 0,
  awaitingClientRuns: 0,
  activeChildRuns: 0,
  pendingActions: 0,
});

/**
 * Attività degli agenti che non sono fermi, in ordine di id (gli agenti assenti sono fermi). Le run non hanno un
 * proprietario e sono visibili a ogni utente ammesso; le voci in coda contano solo quelle dell'utente.
 */
export async function listAgentActivity(userId: number): Promise<AgentActivity[]> {
  const child = alias(runsTable, "child");
  const [own, children, actions] = await Promise.all([
    db
      .select({ agentId: runsTable.agentId, status: runsTable.status, count: sql<number>`count(*)::int` })
      .from(runsTable)
      .where(inArray(runsTable.status, [...ACTIVE_STATUSES]))
      .groupBy(runsTable.agentId, runsTable.status),
    db
      .select({ agentId: runsTable.agentId, count: sql<number>`count(*)::int` })
      .from(child)
      .innerJoin(runsTable, eq(child.parentRunId, runsTable.id))
      .where(inArray(child.status, [...ACTIVE_STATUSES]))
      .groupBy(runsTable.agentId),
    db
      .select({ agentId: pendingActionsTable.agentId, count: sql<number>`count(*)::int` })
      .from(pendingActionsTable)
      .where(
        and(
          eq(pendingActionsTable.userId, userId),
          eq(pendingActionsTable.status, "pending"),
          isNotNull(pendingActionsTable.agentId),
        ),
      )
      .groupBy(pendingActionsTable.agentId),
  ]);

  const byAgent = new Map<number, Counts>();
  const countsOf = (agentId: number) => {
    let c = byAgent.get(agentId);
    if (!c) byAgent.set(agentId, (c = emptyCounts()));
    return c;
  };
  for (const row of own) {
    const c = countsOf(row.agentId);
    const n = Number(row.count);
    if (row.status === "running") c.runningRuns += n;
    else if (row.status === "pending") c.pendingRuns += n;
    else if (row.status === "awaiting_client") c.awaitingClientRuns += n;
  }
  for (const row of children) countsOf(row.agentId).activeChildRuns += Number(row.count);
  for (const row of actions) {
    if (row.agentId !== null) countsOf(row.agentId).pendingActions += Number(row.count);
  }

  return [...byAgent.entries()]
    .sort(([a], [b]) => a - b)
    .map(([agentId, c]) => ({ agentId, state: agentState(c), ...c }));
}

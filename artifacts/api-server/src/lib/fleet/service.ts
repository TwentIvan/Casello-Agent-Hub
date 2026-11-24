// Vista della flotta degli agenti (issue #117): salute, attività e numeri delle ultime 24 ore per ogni agente, più il
// riepilogo e la politica di coordinamento. Solo letture, nessun modello. Agenti e run sono condivisi tra gli utenti
// ammessi; le voci di «Da confermare» contano solo quelle dell'utente (come in lib/live/activity.ts).
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { agentTriggersTable, agentsTable, appsTable, db, runsTable } from "@workspace/db";
import { listAgentActivity, type AgentActivityState } from "../live/activity";
import { FLEET_STUCK_MS, FLEET_WINDOW_MS, fleetHealth, successRate, type FleetHealth, type FleetIssue } from "./health";
import { readFleetPolicy, type FleetPolicy } from "./policy";

/** Lunghezza massima dell'ultimo errore mostrato. */
const LAST_ERROR_MAX = 200;

export interface FleetAgent {
  agentId: number;
  name: string;
  appId: number;
  appName: string;
  role: "general" | "area";
  status: "draft" | "active" | "inactive";
  health: FleetHealth;
  issues: FleetIssue[];
  activity: AgentActivityState;
  runningRuns: number;
  pendingRuns: number;
  pendingActions: number;
  triggersInError: number;
  succeeded24h: number;
  failed24h: number;
  cancelled24h: number;
  successRate: number | null;
  avgDurationMs: number | null;
  cost24hUsd: number | null;
  unpriced24h: number;
  lastRunAt: Date | null;
  lastError: string | null;
}

export interface FleetSummary {
  agents: number;
  healthy: number;
  degraded: number;
  failing: number;
  off: number;
  working: number;
  waitingUser: number;
  runningRuns: number;
  pendingRuns: number;
  succeeded24h: number;
  failed24h: number;
  cost24hUsd: number;
}

export interface FleetView {
  policy: FleetPolicy;
  summary: FleetSummary;
  agents: FleetAgent[];
}

const HEALTH_ORDER: Record<FleetHealth, number> = { failing: 0, degraded: 1, healthy: 2, off: 3 };

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LAST_ERROR_MAX ? `${flat.slice(0, LAST_ERROR_MAX - 1)}…` : flat;
}

/** Vista completa della flotta, dalla più grave: falliscono, rallentate, sane, spente; poi per nome. */
export async function getFleet(userId: number, now = new Date()): Promise<FleetView> {
  const since = new Date(now.getTime() - FLEET_WINDOW_MS);
  const stuckBefore = new Date(now.getTime() - FLEET_STUCK_MS);

  const [policy, agents, activity, finished, open, stuck, triggers, lastRuns, lastErrors] = await Promise.all([
    readFleetPolicy(),
    db
      .select({
        id: agentsTable.id,
        name: agentsTable.name,
        appId: agentsTable.appId,
        appName: appsTable.name,
        role: agentsTable.role,
        status: agentsTable.status,
        aiModelId: agentsTable.aiModelId,
      })
      .from(agentsTable)
      .innerJoin(appsTable, eq(appsTable.id, agentsTable.appId)),
    listAgentActivity(userId),
    db
      .select({
        agentId: runsTable.agentId,
        status: runsTable.status,
        count: sql<number>`count(*)::int`,
        avgDuration: sql<number | null>`avg(${runsTable.durationMs})::float`,
        cost: sql<string | null>`sum(${runsTable.costUsd})`,
        unpriced: sql<number>`count(*) filter (where ${runsTable.costUsd} is null and coalesce(${runsTable.promptTokens}, 0) + coalesce(${runsTable.completionTokens}, 0) > 0)::int`,
      })
      .from(runsTable)
      .where(and(inArray(runsTable.status, ["succeeded", "failed", "cancelled"]), gte(runsTable.finishedAt, since)))
      .groupBy(runsTable.agentId, runsTable.status),
    db
      .select({ agentId: runsTable.agentId, status: runsTable.status, count: sql<number>`count(*)::int` })
      .from(runsTable)
      .where(inArray(runsTable.status, ["pending", "running"]))
      .groupBy(runsTable.agentId, runsTable.status),
    db
      .select({ agentId: runsTable.agentId, count: sql<number>`count(*)::int` })
      .from(runsTable)
      .where(and(eq(runsTable.status, "running"), sql`${runsTable.createdAt} < ${stuckBefore}`))
      .groupBy(runsTable.agentId),
    db
      .select({ agentId: agentTriggersTable.agentId, count: sql<number>`count(*)::int` })
      .from(agentTriggersTable)
      .where(eq(agentTriggersTable.status, "error"))
      .groupBy(agentTriggersTable.agentId),
    db
      .select({ agentId: runsTable.agentId, last: sql<Date | null>`max(${runsTable.createdAt})` })
      .from(runsTable)
      .groupBy(runsTable.agentId),
    // Ultimo errore per agente nella finestra: distinct on, una riga per agente
    db.execute<{ agent_id: number; error_message: string }>(sql`
      select distinct on (agent_id) agent_id, error_message
        from runs
       where status = 'failed' and finished_at >= ${since} and error_message is not null
       order by agent_id, finished_at desc, id desc`),
  ]);

  const activityById = new Map(activity.map((a) => [a.agentId, a]));
  const finishedById = new Map<number, { succeeded: number; failed: number; cancelled: number; durSum: number; durCount: number; cost: number; priced: boolean; unpriced: number }>();
  for (const r of finished) {
    let f = finishedById.get(r.agentId);
    if (!f) finishedById.set(r.agentId, (f = { succeeded: 0, failed: 0, cancelled: 0, durSum: 0, durCount: 0, cost: 0, priced: false, unpriced: 0 }));
    const n = Number(r.count);
    if (r.status === "succeeded") f.succeeded += n;
    else if (r.status === "failed") f.failed += n;
    else f.cancelled += n;
    if (r.avgDuration !== null && r.status !== "cancelled") {
      f.durSum += Number(r.avgDuration) * n;
      f.durCount += n;
    }
    if (r.cost !== null) {
      f.cost += Number(r.cost);
      f.priced = true;
    }
    f.unpriced += Number(r.unpriced);
  }
  const openById = new Map<number, { running: number; pending: number }>();
  for (const r of open) {
    let o = openById.get(r.agentId);
    if (!o) openById.set(r.agentId, (o = { running: 0, pending: 0 }));
    if (r.status === "running") o.running += Number(r.count);
    else o.pending += Number(r.count);
  }
  const stuckById = new Map(stuck.map((r) => [r.agentId, Number(r.count)]));
  const triggersById = new Map(triggers.map((r) => [r.agentId, Number(r.count)]));
  const lastRunById = new Map(lastRuns.map((r) => [r.agentId, r.last === null ? null : new Date(r.last)]));
  const lastErrorById = new Map(lastErrors.rows.map((r) => [Number(r.agent_id), oneLine(String(r.error_message))]));

  const list: FleetAgent[] = agents.map((a) => {
    const f = finishedById.get(a.id);
    const o = openById.get(a.id) ?? { running: 0, pending: 0 };
    const act = activityById.get(a.id);
    const triggersInError = triggersById.get(a.id) ?? 0;
    const { health, issues } = fleetHealth({
      status: a.status,
      hasModel: a.aiModelId !== null,
      succeeded: f?.succeeded ?? 0,
      failed: f?.failed ?? 0,
      triggersInError,
      pendingRuns: o.pending,
      stuckRuns: stuckById.get(a.id) ?? 0,
    });
    return {
      agentId: a.id,
      name: a.name,
      appId: a.appId,
      appName: a.appName,
      role: a.role,
      status: a.status,
      health,
      issues,
      activity: act?.state ?? "idle",
      runningRuns: o.running,
      pendingRuns: o.pending,
      pendingActions: act?.pendingActions ?? 0,
      triggersInError,
      succeeded24h: f?.succeeded ?? 0,
      failed24h: f?.failed ?? 0,
      cancelled24h: f?.cancelled ?? 0,
      successRate: successRate(f?.succeeded ?? 0, f?.failed ?? 0),
      avgDurationMs: f && f.durCount > 0 ? Math.round(f.durSum / f.durCount) : null,
      cost24hUsd: f?.priced ? Math.round(f.cost * 1_000_000) / 1_000_000 : null,
      unpriced24h: f?.unpriced ?? 0,
      lastRunAt: lastRunById.get(a.id) ?? null,
      lastError: lastErrorById.get(a.id) ?? null,
    };
  });
  list.sort((x, y) => HEALTH_ORDER[x.health] - HEALTH_ORDER[y.health] || x.name.localeCompare(y.name, "it") || x.agentId - y.agentId);

  const summary: FleetSummary = {
    agents: list.length,
    healthy: 0,
    degraded: 0,
    failing: 0,
    off: 0,
    working: 0,
    waitingUser: 0,
    runningRuns: 0,
    pendingRuns: 0,
    succeeded24h: 0,
    failed24h: 0,
    cost24hUsd: 0,
  };
  for (const a of list) {
    summary[a.health]++;
    if (a.activity === "working") summary.working++;
    else if (a.activity === "waiting_user") summary.waitingUser++;
    summary.runningRuns += a.runningRuns;
    summary.pendingRuns += a.pendingRuns;
    summary.succeeded24h += a.succeeded24h;
    summary.failed24h += a.failed24h;
    summary.cost24hUsd += a.cost24hUsd ?? 0;
  }
  summary.cost24hUsd = Math.round(summary.cost24hUsd * 1_000_000) / 1_000_000;
  return { policy, summary, agents: list };
}


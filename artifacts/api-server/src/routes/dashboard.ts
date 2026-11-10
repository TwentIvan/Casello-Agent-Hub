import { Router, type IRouter } from "express";
import { sql, eq, and, gte, desc } from "drizzle-orm";
import { currentUserId } from "../lib/auth";
import { db, aiAccountsTable, appsTable, agentsTable, agentTriggersTable, nodesTable, runsTable, pendingActionsTable } from "@workspace/db";
import { GetDashboardStatsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

/** Il login di Claude scade entro questo tempo: avviso in Dashboard. */
const LOGIN_EXPIRING_MS = 3 * 86_400_000;

/** Scadenza del login di Claude Code in millisecondi: data ISO o numero (secondi o millisecondi); null se non riconoscibile. */
function loginExpiry(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

type ClaudeWarning = "not_installed" | "not_logged_in" | "login_expiring";

/** Motivo dell'avviso sullo stato di Claude di un nodo; null se va bene o non si sa ancora. */
function claudeWarning(status: Record<string, unknown> | null, now: number): ClaudeWarning | null {
  if (!status) return null;
  if (status["found"] !== true) return "not_installed";
  // loggedIn assente = non si sa (es. `claude auth status` non riuscito): nessun avviso
  if (status["loggedIn"] === false) return "not_logged_in";
  const expires = loginExpiry(status["loginExpiresAt"]);
  return expires !== null && expires - now <= LOGIN_EXPIRING_MS ? "login_expiring" : null;
}

router.get("/dashboard/stats", async (req, res) => {
  const [{ count: totalApps }] = await db.select({ count: sql<number>`count(*)::int` }).from(appsTable);
  const [{ count: totalAgents }] = await db.select({ count: sql<number>`count(*)::int` }).from(agentsTable);
  const [{ count: activeAgents }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentsTable)
    .where(eq(agentsTable.status, "active"));
  const [{ count: totalRuns }] = await db.select({ count: sql<number>`count(*)::int` }).from(runsTable);
  const [{ count: successfulRuns }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runsTable)
    .where(eq(runsTable.status, "succeeded"));
  const [{ count: failedRuns }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runsTable)
    .where(eq(runsTable.status, "failed"));
  const [{ count: cancelledRuns }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runsTable)
    .where(eq(runsTable.status, "cancelled"));
  const [{ avg: avgDurationMs }] = await db
    .select({ avg: sql<number | null>`avg(${runsTable.durationMs})::float` })
    .from(runsTable);

  const [{ count: pendingActions }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pendingActionsTable)
    .where(and(eq(pendingActionsTable.userId, currentUserId(req)), eq(pendingActionsTable.status, "pending")));

  // Inneschi fermi in errore: agenti e app sono condivisi tra gli utenti ammessi, si contano tutti
  const [{ count: triggersInError }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentTriggersTable)
    .where(eq(agentTriggersTable.status, "error"));

  const userId = currentUserId(req);
  const now = Date.now();
  // Nodi dell'utente collegati nelle ultime 24 ore (l'avviso a ogni nuovo collegamento)
  const pairedRows = await db
    .select({ id: nodesTable.id, name: nodesTable.name, pairedAt: nodesTable.pairedAt })
    .from(nodesTable)
    .where(and(eq(nodesTable.userId, userId), eq(nodesTable.status, "active"), gte(nodesTable.pairedAt, new Date(now - 24 * 3600_000))))
    .orderBy(desc(nodesTable.pairedAt));
  const recentlyPairedNodes = pairedRows.map((r) => ({ id: r.id, name: r.name, pairedAt: r.pairedAt! }));
  // Claude non pronto sui nodi che hanno un account «Claude Code (nodo)» dell'utente
  const claudeRows = await db
    .select({ nodeId: nodesTable.id, nodeName: nodesTable.name, claude: nodesTable.claudeStatus })
    .from(nodesTable)
    .innerJoin(aiAccountsTable, and(eq(aiAccountsTable.nodeId, nodesTable.id), eq(aiAccountsTable.userId, userId)))
    .where(and(eq(nodesTable.userId, userId), eq(nodesTable.status, "active")));
  const nodeClaudeWarnings = claudeRows.flatMap((r) => {
    const reason = claudeWarning(r.claude, now);
    return reason ? [{ nodeId: r.nodeId, nodeName: r.nodeName, reason }] : [];
  });

  res.json(
    GetDashboardStatsResponse.parse({
      totalApps,
      totalAgents,
      activeAgents,
      totalRuns,
      successfulRuns,
      failedRuns,
      cancelledRuns,
      pendingActions,
      triggersInError,
      recentlyPairedNodes,
      nodeClaudeWarnings,
      avgDurationMs,
    })
  );
});

export default router;

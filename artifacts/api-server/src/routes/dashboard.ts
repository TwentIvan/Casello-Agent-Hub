import { Router, type IRouter } from "express";
import { sql, eq } from "drizzle-orm";
import { db, appsTable, agentsTable, runsTable } from "@workspace/db";
import { GetDashboardStatsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard/stats", async (_req, res) => {
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

  res.json(
    GetDashboardStatsResponse.parse({
      totalApps,
      totalAgents,
      activeAgents,
      totalRuns,
      successfulRuns,
      failedRuns,
      cancelledRuns,
      avgDurationMs,
    })
  );
});

export default router;

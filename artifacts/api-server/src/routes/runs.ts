import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, runsTable } from "@workspace/db";
import { ListRunsQueryParams, ListRunsResponse, GetRunParams, GetRunResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/runs", async (req, res) => {
  const { agentId, status } = ListRunsQueryParams.parse(req.query);
  const conditions = [
    ...(agentId !== undefined ? [eq(runsTable.agentId, agentId)] : []),
    ...(status !== undefined ? [eq(runsTable.status, status)] : []),
  ];
  const runs = await db
    .select()
    .from(runsTable)
    .where(conditions.length ? and(...conditions) : undefined);
  res.json(ListRunsResponse.parse(runs));
});

router.get("/runs/:id", async (req, res) => {
  const { id } = GetRunParams.parse(req.params);
  const [run] = await db.select().from(runsTable).where(eq(runsTable.id, id)).limit(1);
  if (!run) {
    res.status(404).json({ error: "Esecuzione non trovata" });
    return;
  }
  res.json(GetRunResponse.parse(run));
});

export default router;

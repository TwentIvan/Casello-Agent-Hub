import { Router, type IRouter } from "express";
import { eq, and, asc, desc } from "drizzle-orm";
import { db, runsTable, runStepsTable } from "@workspace/db";
import {
  ListRunsQueryParams,
  ListRunsResponse,
  GetRunParams,
  GetRunResponse,
  ListRunStepsParams,
  ListRunStepsResponse,
  ResumeRunParams,
  ResumeRunBody,
  ResumeRunResponse,
} from "@workspace/api-zod";
import { runRateLimit } from "../middlewares/rate-limit";
import { ResumeConflictError, claimResume } from "../lib/run-executor";
import { logger } from "../lib/logger";
import { toPublicRun, userTokenFrom } from "./serializers";
import { parseRequest } from "../middlewares/error-handler";

const router: IRouter = Router();

router.get("/runs", async (req, res) => {
  const { agentId, status } = parseRequest(ListRunsQueryParams, req.query);
  const conditions = [
    ...(agentId !== undefined ? [eq(runsTable.agentId, agentId)] : []),
    ...(status !== undefined ? [eq(runsTable.status, status)] : []),
  ];
  const runs = await db
    .select()
    .from(runsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(runsTable.createdAt), desc(runsTable.id));
  res.json(ListRunsResponse.parse(runs.map(toPublicRun)));
});

router.get("/runs/:id", async (req, res) => {
  const { id } = parseRequest(GetRunParams, req.params);
  const [run] = await db.select().from(runsTable).where(eq(runsTable.id, id)).limit(1);
  if (!run) {
    res.status(404).json({ error: "Esecuzione non trovata" });
    return;
  }
  res.json(GetRunResponse.parse(toPublicRun(run)));
});

router.get("/runs/:id/steps", async (req, res) => {
  const { id } = parseRequest(ListRunStepsParams, req.params);
  const [run] = await db.select({ id: runsTable.id }).from(runsTable).where(eq(runsTable.id, id)).limit(1);
  if (!run) {
    res.status(404).json({ error: "Esecuzione non trovata" });
    return;
  }
  const steps = await db
    .select()
    .from(runStepsTable)
    .where(eq(runStepsTable.runId, id))
    .orderBy(asc(runStepsTable.position));
  res.json(ListRunStepsResponse.parse(steps));
});

// Ripresa di una run in pausa. La presa in carico (awaiting_client → running, UPDATE condizionato)
// è attesa qui: una seconda ripresa, una pausa scaduta o un'azione incoerente rispondono 409 senza
// eseguire il tool. Il resto del turno prosegue in background, come all'avvio.
router.post("/runs/:id/resume", runRateLimit, async (req, res) => {
  const { id } = parseRequest(ResumeRunParams, req.params);
  const { decision } = parseRequest(ResumeRunBody, req.body);

  const [existing] = await db.select({ id: runsTable.id }).from(runsTable).where(eq(runsTable.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Esecuzione non trovata" });
    return;
  }

  let claimed: Awaited<ReturnType<typeof claimResume>>;
  try {
    claimed = await claimResume(id, decision, { userToken: userTokenFrom(req) });
  } catch (err) {
    if (!(err instanceof ResumeConflictError)) throw err;
    res.status(409).json({ error: err.message });
    return;
  }

  claimed.proceed().catch((err: unknown) => logger.error({ err, runId: id }, "Ripresa della run fallita"));

  res.status(202).json(ResumeRunResponse.parse(toPublicRun(claimed.run)));
});

export default router;

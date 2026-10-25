import { Router, type IRouter } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, agentsTable, agentToolsTable, appsTable, appToolsTable, runsTable } from "@workspace/db";
import { runRateLimit } from "../middlewares/rate-limit";
import {
  ListAgentsQueryParams,
  ListAgentsResponse,
  CreateAgentBody,
  CreateAgentResponse,
  GetAgentParams,
  GetAgentResponse,
  UpdateAgentParams,
  UpdateAgentBody,
  UpdateAgentResponse,
  DeleteAgentParams,
  SetAgentToolsParams,
  SetAgentToolsBody,
  SetAgentToolsResponse,
  TriggerRunParams,
  TriggerRunBody,
  TriggerRunResponse,
} from "@workspace/api-zod";
import { startRun } from "../lib/run-executor";
import { logger } from "../lib/logger";
import { toPublicRun, userTokenFrom, withToolIds, withToolIdsOne } from "./serializers";

const router: IRouter = Router();

router.get("/agents", async (req, res) => {
  const { appId } = ListAgentsQueryParams.parse(req.query);
  const agents = await db
    .select()
    .from(agentsTable)
    .where(appId !== undefined ? eq(agentsTable.appId, appId) : undefined)
    .orderBy(asc(agentsTable.id));
  res.json(ListAgentsResponse.parse(await withToolIds(agents)));
});

// Gli agenti creati dalla UI sono sempre di area: il generale nasce con l'app
router.post("/agents", async (req, res) => {
  const body = CreateAgentBody.parse(req.body);
  const [app] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, body.appId)).limit(1);
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  const [agent] = await db
    .insert(agentsTable)
    .values({ ...body, role: "area" })
    .returning();
  res.status(201).json(CreateAgentResponse.parse(await withToolIdsOne(agent!)));
});

router.get("/agents/:id", async (req, res) => {
  const { id } = GetAgentParams.parse(req.params);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }
  res.json(GetAgentResponse.parse(await withToolIdsOne(agent)));
});

router.patch("/agents/:id", async (req, res) => {
  const { id } = UpdateAgentParams.parse(req.params);
  const body = UpdateAgentBody.parse(req.body);
  const [agent] = await db
    .update(agentsTable)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(agentsTable.id, id))
    .returning();
  if (!agent) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }
  res.json(UpdateAgentResponse.parse(await withToolIdsOne(agent)));
});

router.delete("/agents/:id", async (req, res) => {
  const { id } = DeleteAgentParams.parse(req.params);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }
  if (agent.role === "general") {
    res.status(409).json({ error: "L'agente generale non si può eliminare" });
    return;
  }
  await db.delete(agentsTable).where(eq(agentsTable.id, id));
  res.status(204).end();
});

// ── Tool assegnati all'agente ───────────────────────────────────────────────

router.put("/agents/:id/tools", async (req, res) => {
  const { id } = SetAgentToolsParams.parse(req.params);
  const toolIds = [...new Set(SetAgentToolsBody.parse(req.body).toolIds)];

  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }
  if (agent.role === "general") {
    res.status(400).json({ error: "L'agente generale usa tutti i tool attivi dell'app: non gli si assegnano tool" });
    return;
  }
  if (toolIds.length) {
    const owned = await db
      .select({ id: appToolsTable.id })
      .from(appToolsTable)
      .where(and(eq(appToolsTable.appId, agent.appId), inArray(appToolsTable.id, toolIds)));
    if (owned.length !== toolIds.length) {
      res.status(400).json({ error: "Alcuni strumenti non esistono o non appartengono all'app dell'agente" });
      return;
    }
  }

  const updated = await db.transaction(async (tx) => {
    await tx.delete(agentToolsTable).where(eq(agentToolsTable.agentId, id));
    if (toolIds.length) {
      await tx.insert(agentToolsTable).values(toolIds.map((toolId) => ({ agentId: id, toolId })));
    }
    const [row] = await tx
      .update(agentsTable)
      .set({ updatedAt: new Date() })
      .where(eq(agentsTable.id, id))
      .returning();
    return row!;
  });
  res.json(SetAgentToolsResponse.parse(await withToolIdsOne(updated)));
});

// ── Run (avviate su un agente) ──────────────────────────────────────────────

router.post("/agents/:id/runs", runRateLimit, async (req, res) => {
  const { id } = TriggerRunParams.parse(req.params);
  const body = TriggerRunBody.parse(req.body);
  const userToken = userTokenFrom(req);

  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }

  const [run] = await db
    .insert(runsTable)
    .values({ agentId: id, status: "pending", input: body.input ?? null })
    .returning();

  // La run prosegue in background (da secondi a decine di secondi): si risponde subito con la run
  // in attesa e la UI ne segue lo stato con GET /runs/:id. startRun registra da sé gli errori del
  // modello sulla run; qui si intercetta solo l'imprevisto, che altrimenti farebbe cadere il processo.
  startRun(run!.id, { userToken }).catch((err: unknown) =>
    logger.error({ err, runId: run!.id }, "Esecuzione della run fallita"),
  );

  res.status(202).json(TriggerRunResponse.parse(toPublicRun(run!)));
});

export default router;

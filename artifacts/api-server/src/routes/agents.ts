import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, agentsTable, toolsTable, runsTable } from "@workspace/db";
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
  ListToolsParams,
  ListToolsResponse,
  CreateToolParams,
  CreateToolBody,
  CreateToolResponse,
  DeleteToolParams,
  TriggerRunParams,
  TriggerRunBody,
  TriggerRunResponse,
} from "@workspace/api-zod";
import { executeRun } from "../lib/run-executor";

const router: IRouter = Router();

router.get("/agents", async (req, res) => {
  const { appId } = ListAgentsQueryParams.parse(req.query);
  const agents = await db
    .select()
    .from(agentsTable)
    .where(appId !== undefined ? eq(agentsTable.appId, appId) : undefined);
  res.json(ListAgentsResponse.parse(agents));
});

router.post("/agents", async (req, res) => {
  const body = CreateAgentBody.parse(req.body);
  const [agent] = await db.insert(agentsTable).values(body).returning();
  res.status(201).json(CreateAgentResponse.parse(agent));
});

router.get("/agents/:id", async (req, res) => {
  const { id } = GetAgentParams.parse(req.params);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }
  res.json(GetAgentResponse.parse(agent));
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
  res.json(UpdateAgentResponse.parse(agent));
});

router.delete("/agents/:id", async (req, res) => {
  const { id } = DeleteAgentParams.parse(req.params);
  const [agent] = await db.delete(agentsTable).where(eq(agentsTable.id, id)).returning();
  if (!agent) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }
  res.status(204).end();
});

// ── Tools (nested under an agent) ───────────────────────────────────────────

router.get("/agents/:id/tools", async (req, res) => {
  const { id } = ListToolsParams.parse(req.params);
  const tools = await db.select().from(toolsTable).where(eq(toolsTable.agentId, id));
  res.json(ListToolsResponse.parse(tools));
});

router.post("/agents/:id/tools", async (req, res) => {
  const { id } = CreateToolParams.parse(req.params);
  const body = CreateToolBody.parse(req.body);
  const [tool] = await db
    .insert(toolsTable)
    .values({ ...body, agentId: id })
    .returning();
  res.status(201).json(CreateToolResponse.parse(tool));
});

router.delete("/agents/:agentId/tools/:toolId", async (req, res) => {
  const { agentId, toolId } = DeleteToolParams.parse(req.params);
  const [tool] = await db
    .delete(toolsTable)
    .where(and(eq(toolsTable.id, toolId), eq(toolsTable.agentId, agentId)))
    .returning();
  if (!tool) {
    res.status(404).json({ error: "Strumento non trovato" });
    return;
  }
  res.status(204).end();
});

// ── Runs (triggered on an agent) ────────────────────────────────────────────

router.post("/agents/:id/runs", async (req, res) => {
  const { id } = TriggerRunParams.parse(req.params);
  const body = TriggerRunBody.parse(req.body);

  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }

  const [run] = await db
    .insert(runsTable)
    .values({ agentId: id, status: "pending", input: body.input ?? null })
    .returning();

  await executeRun(run.id);

  const [finished] = await db.select().from(runsTable).where(eq(runsTable.id, run.id)).limit(1);
  res.status(202).json(TriggerRunResponse.parse(finished));
});

export default router;

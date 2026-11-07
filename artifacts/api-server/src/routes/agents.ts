import { Router, type IRouter } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  agentSkillsTable,
  agentsTable,
  appsTable,
} from "@workspace/db";
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
  SetAppAgentModelsParams,
  SetAppAgentModelsBody,
  SetAppAgentModelsResponse,
  TriggerRunParams,
  TriggerRunBody,
  TriggerRunResponse,
  ListAgentSkillsParams,
  ListAgentSkillsResponse,
  DeleteAgentSkillParams,
} from "@workspace/api-zod";
import { AGENT_WITHOUT_MODEL } from "../lib/run-executor";
import { RUN_QUEUE_MESSAGES, createQueuedRun } from "../lib/run-queue";
import { AgentError, createAreaAgent, setAgentTools, updateAgent } from "../lib/agents";
import { budgetColumn, runBudgetBlock } from "../lib/budget";
import { currentUserId } from "../lib/auth";
import { ModelChoiceError, NO_MODEL, chooseOwnModel, type ModelChoice } from "../lib/ai/choice";
import { resolveAgentModel } from "../lib/ai/default-model";
import { toPublicRun, userTokenFrom, withToolIds, withToolIdsOne } from "./serializers";
import { parseRequest } from "../middlewares/error-handler";

const router: IRouter = Router();

router.get("/agents", async (req, res) => {
  const { appId } = parseRequest(ListAgentsQueryParams, req.query);
  const agents = await db
    .select()
    .from(agentsTable)
    .where(appId !== undefined ? eq(agentsTable.appId, appId) : undefined)
    .orderBy(asc(agentsTable.id));
  res.json(ListAgentsResponse.parse(await withToolIds(agents)));
});

// Gli agenti creati dalla UI sono sempre di area: il generale nasce con l'app.
// Modello (chi configura paga): `aiModelId` deve essere un modello di un account dell'utente;
// senza, il predefinito dell'utente (se è ancora suo), altrimenti nessuno.
router.post("/agents", async (req, res) => {
  const { aiModelId, ...body } = parseRequest(CreateAgentBody, req.body);
  const [app] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, body.appId)).limit(1);
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  let choice: ModelChoice;
  try {
    choice = await resolveAgentModel(currentUserId(req), aiModelId);
  } catch (err) {
    if (!(err instanceof ModelChoiceError)) throw err;
    res.status(400).json({ error: err.message });
    return;
  }
  let agent;
  try {
    agent = await createAreaAgent(body, choice);
  } catch (err) {
    if (!(err instanceof AgentError)) throw err;
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(201).json(CreateAgentResponse.parse(await withToolIdsOne(agent)));
});

router.get("/agents/:id", async (req, res) => {
  const { id } = parseRequest(GetAgentParams, req.params);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }
  res.json(GetAgentResponse.parse(await withToolIdsOne(agent)));
});

/**
 * Campi del modello da aggiornare. Si controlla solo un modello che CAMBIA: chi modifica un agente
 * configurato da un altro utente (es. solo il nome) ne conserva il modello, e quindi l'account che
 * paga, senza poterlo scegliere lui. `aiModelId: null` toglie il modello: le run non partono finché
 * non se ne sceglie un altro.
 */
async function modelUpdate(
  current: { aiModelId: number | null },
  aiModelId: number | null | undefined,
  userId: number,
): Promise<Partial<ModelChoice>> {
  if (aiModelId === undefined || aiModelId === current.aiModelId) return {};
  if (aiModelId === null) return NO_MODEL;
  return chooseOwnModel(aiModelId, userId);
}

router.patch("/agents/:id", async (req, res) => {
  const { id } = parseRequest(UpdateAgentParams, req.params);
  const { aiModelId, monthlyBudgetUsd, ...body } = parseRequest(UpdateAgentBody, req.body);
  const [current] = await db
    .select({ aiModelId: agentsTable.aiModelId })
    .from(agentsTable)
    .where(eq(agentsTable.id, id))
    .limit(1);
  if (!current) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }
  let modelFields: Partial<ModelChoice>;
  try {
    modelFields = await modelUpdate(current, aiModelId, currentUserId(req));
  } catch (err) {
    if (!(err instanceof ModelChoiceError)) throw err;
    res.status(400).json({ error: err.message });
    return;
  }
  try {
    const agent = await updateAgent(id, {
      ...body,
      ...modelFields,
      ...(monthlyBudgetUsd !== undefined && { monthlyBudgetUsd: budgetColumn(monthlyBudgetUsd) }),
    });
    res.json(UpdateAgentResponse.parse(await withToolIdsOne(agent)));
  } catch (err) {
    if (!(err instanceof AgentError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

router.delete("/agents/:id", async (req, res) => {
  const { id } = parseRequest(DeleteAgentParams, req.params);
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
  const { id } = parseRequest(SetAgentToolsParams, req.params);
  const { toolIds } = parseRequest(SetAgentToolsBody, req.body);
  let updated;
  try {
    updated = await setAgentTools(id, toolIds);
  } catch (err) {
    if (!(err instanceof AgentError)) throw err;
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.json(SetAgentToolsResponse.parse(await withToolIdsOne(updated)));
});

// ── Mappa dei modelli degli agenti di un'app ────────────────────────────────

// Tutto o niente: prima si verifica ogni agente (dell'app) e ogni modello (dell'utente, come per
// `PATCH /agents/:id`), poi si aggiorna in una sola transazione. null = nessun modello.
router.put("/apps/:id/agent-models", async (req, res) => {
  const { id } = parseRequest(SetAppAgentModelsParams, req.params);
  const { assignments } = parseRequest(SetAppAgentModelsBody, req.body);

  const agentIds = assignments.map((a) => a.agentId);
  if (new Set(agentIds).size !== agentIds.length) {
    res.status(400).json({ error: "Un agente compare più volte" });
    return;
  }
  const [app] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, id)).limit(1);
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  const owned = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(and(eq(agentsTable.appId, id), inArray(agentsTable.id, agentIds)));
  if (owned.length !== agentIds.length) {
    res.status(400).json({ error: "Alcuni agenti non esistono o non appartengono all'app" });
    return;
  }
  const userId = currentUserId(req);
  let choices: ModelChoice[];
  try {
    choices = await Promise.all(
      assignments.map((a) => (a.aiModelId === null ? NO_MODEL : chooseOwnModel(a.aiModelId, userId))),
    );
  } catch (err) {
    if (!(err instanceof ModelChoiceError)) throw err;
    res.status(400).json({ error: err.message });
    return;
  }

  const updated = await db.transaction(async (tx) => {
    const rows = [];
    for (const [i, a] of assignments.entries()) {
      const [row] = await tx
        .update(agentsTable)
        .set({ ...choices[i]!, updatedAt: new Date() })
        .where(and(eq(agentsTable.id, a.agentId), eq(agentsTable.appId, id)))
        .returning();
      rows.push(row!);
    }
    return rows;
  });
  res.json(SetAppAgentModelsResponse.parse(await withToolIds(updated)));
});

// ── Skill dell'agente (create approvando le proposte dell'architetto) ───────

router.get("/agents/:id/skills", async (req, res) => {
  const { id } = parseRequest(ListAgentSkillsParams, req.params);
  const [agent] = await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }
  const skills = await db
    .select()
    .from(agentSkillsTable)
    .where(eq(agentSkillsTable.agentId, id))
    .orderBy(asc(agentSkillsTable.id));
  res.json(ListAgentSkillsResponse.parse(skills));
});

// La skill deve appartenere all'agente del percorso: altrimenti 404, come se non esistesse
router.delete("/agents/:id/skills/:skillId", async (req, res) => {
  const { id, skillId } = parseRequest(DeleteAgentSkillParams, req.params);
  const [skill] = await db
    .delete(agentSkillsTable)
    .where(and(eq(agentSkillsTable.id, skillId), eq(agentSkillsTable.agentId, id)))
    .returning({ id: agentSkillsTable.id });
  if (!skill) {
    res.status(404).json({ error: "Skill non trovata" });
    return;
  }
  res.status(204).end();
});

// ── Run (avviate su un agente) ──────────────────────────────────────────────

router.post("/agents/:id/runs", runRateLimit, async (req, res) => {
  const { id } = parseRequest(TriggerRunParams, req.params);
  const body = parseRequest(TriggerRunBody, req.body);
  const userToken = userTokenFrom(req);

  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }
  // Niente più ripiego sul gateway: senza modello la run non parte (nessuna run creata)
  if (agent.aiModelId === null) {
    res.status(409).json({ error: AGENT_WITHOUT_MODEL });
    return;
  }

  const blocked = await runBudgetBlock(agent);
  if (blocked) {
    res.status(409).json({ error: blocked });
    return;
  }

  // Il modello si fissa sulla run: la spesa resta di chi pagava alla partenza anche se l'agente cambia modello.
  // La run va in coda: la avvia lo scheduler (run-queue.ts) quando c'è posto, e la UI ne segue lo stato con
  // GET /runs/:id. Tetti e modello si ricontrollano alla partenza.
  const queued = await createQueuedRun({ agent, input: body.input ?? null, userToken });
  if (!queued.ok) {
    res.status(429).json({ error: RUN_QUEUE_MESSAGES.queueFull });
    return;
  }
  const run = queued.run;

  res.status(202).json(TriggerRunResponse.parse(toPublicRun(run)));
});

export default router;

import { Router, type IRouter } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  agentSkillsTable,
  agentsTable,
  agentToolsTable,
  appsTable,
  appToolsTable,
  runsTable,
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
  TriggerRunParams,
  TriggerRunBody,
  TriggerRunResponse,
  ListAgentSkillsParams,
  ListAgentSkillsResponse,
  DeleteAgentSkillParams,
} from "@workspace/api-zod";
import { startRun } from "../lib/run-executor";
import { budgetColumn, runBudgetBlock } from "../lib/budget";
import { currentUserId } from "../lib/auth";
import { ModelChoiceError, chooseByName, chooseOwnModel, type ModelChoice } from "../lib/ai/choice";
import { DEFAULT_MODEL } from "../lib/models";
import { logger } from "../lib/logger";
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
// Modello (chi configura paga): `aiModelId` deve essere un modello dell'utente o dell'account di
// sistema; senza, il nome in `model` (console precedente) si collega al modello di sistema equivalente.
router.post("/agents", async (req, res) => {
  const { aiModelId, model, ...body } = parseRequest(CreateAgentBody, req.body);
  const [app] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, body.appId)).limit(1);
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  let choice: ModelChoice;
  try {
    choice =
      aiModelId != null
        ? await chooseOwnModel(aiModelId, currentUserId(req))
        : await chooseByName(model ?? DEFAULT_MODEL);
  } catch (err) {
    if (!(err instanceof ModelChoiceError)) throw err;
    res.status(400).json({ error: err.message });
    return;
  }
  const [agent] = await db
    .insert(agentsTable)
    .values({ ...body, ...choice, role: "area" })
    .returning();
  res.status(201).json(CreateAgentResponse.parse(await withToolIdsOne(agent!)));
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
 * paga, senza poterlo scegliere lui. Con `aiModelId` impostato `model` segue il modello scelto e il
 * `model` del corpo è ignorato; `aiModelId: null` torna al vecchio percorso del gateway.
 */
async function modelUpdate(
  current: { aiModelId: number | null; model: string },
  body: { aiModelId?: number | null; model?: string },
  userId: number,
): Promise<Partial<ModelChoice>> {
  const { aiModelId, model } = body;
  if (aiModelId !== undefined && aiModelId !== current.aiModelId) {
    if (aiModelId === null) return { aiModelId: null, model: model ?? current.model };
    return chooseOwnModel(aiModelId, userId);
  }
  if (aiModelId === undefined && model !== undefined && model !== current.model) return chooseByName(model);
  return {};
}

router.patch("/agents/:id", async (req, res) => {
  const { id } = parseRequest(UpdateAgentParams, req.params);
  const { aiModelId, model, monthlyBudgetUsd, ...body } = parseRequest(UpdateAgentBody, req.body);
  const [current] = await db
    .select({ aiModelId: agentsTable.aiModelId, model: agentsTable.model })
    .from(agentsTable)
    .where(eq(agentsTable.id, id))
    .limit(1);
  if (!current) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }
  let modelFields: Partial<ModelChoice>;
  try {
    modelFields = await modelUpdate(current, { aiModelId, model }, currentUserId(req));
  } catch (err) {
    if (!(err instanceof ModelChoiceError)) throw err;
    res.status(400).json({ error: err.message });
    return;
  }
  const [agent] = await db
    .update(agentsTable)
    .set({
      ...body,
      ...modelFields,
      ...(monthlyBudgetUsd !== undefined && { monthlyBudgetUsd: budgetColumn(monthlyBudgetUsd) }),
      updatedAt: new Date(),
    })
    .where(eq(agentsTable.id, id))
    .returning();
  if (!agent) {
    res.status(404).json({ error: "Agente non trovato" });
    return;
  }
  res.json(UpdateAgentResponse.parse(await withToolIdsOne(agent)));
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
  const toolIds = [...new Set(parseRequest(SetAgentToolsBody, req.body).toolIds)];

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

  const blocked = await runBudgetBlock(agent);
  if (blocked) {
    res.status(409).json({ error: blocked });
    return;
  }

  // Il modello si fissa sulla run: la spesa resta di chi pagava alla partenza anche se l'agente cambia modello
  const [run] = await db
    .insert(runsTable)
    .values({ agentId: id, aiModelId: agent.aiModelId, status: "pending", input: body.input ?? null })
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

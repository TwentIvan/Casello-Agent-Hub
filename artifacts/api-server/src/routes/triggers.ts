import { Router, type IRouter, type Response } from "express";
import { asc, desc, eq } from "drizzle-orm";
import { db, agentsTable, agentTriggersTable, runsTable } from "@workspace/db";
import {
  ListAgentTriggersParams,
  ListAgentTriggersResponse,
  CreateAgentTriggerParams,
  CreateAgentTriggerBody,
  CreateAgentTriggerResponse,
  TestAgentTriggerConfigParams,
  TestAgentTriggerConfigBody,
  TestAgentTriggerConfigResponse,
  GetTriggerParams,
  GetTriggerResponse,
  UpdateTriggerParams,
  UpdateTriggerBody,
  UpdateTriggerResponse,
  DeleteTriggerParams,
  PauseTriggerParams,
  PauseTriggerResponse,
  ResumeTriggerParams,
  ResumeTriggerResponse,
  TestTriggerParams,
  TestTriggerResponse,
  RegenerateTriggerSecretParams,
  RegenerateTriggerSecretResponse,
  SetTriggerSigningSecretParams,
  SetTriggerSigningSecretBody,
  SetTriggerSigningSecretResponse,
  ListTriggerRunsParams,
  ListTriggerRunsResponse,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { TRIGGER_MESSAGES } from "../lib/triggers/messages";
import {
  createTrigger,
  deleteTrigger,
  loadTrigger,
  pauseTrigger,
  regenerateWebhookSecret,
  resumeTrigger,
  serializeTrigger,
  setSigningSecret,
  testSavedTrigger,
  testTriggerConfig,
  updateTrigger,
  type ServiceResult,
} from "../lib/triggers/service";
import { triggerTestRateLimit } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";
import { toPublicRuns } from "./serializers";

// Inneschi degli agenti (spec §7). Con un token personale valgono gli ambiti per metodo (requireAuth); i segreti del
// webhook si cambiano solo con il login. Errori `{error}` con i messaggi fissi di `TRIGGER_MESSAGES`.

const RUNS_PER_TRIGGER = 20;

/** Esito negativo del servizio → risposta; true se ha risposto. */
function sendFailure<T>(res: Response, result: ServiceResult<T>): result is Extract<ServiceResult<T>, { ok: false }> {
  if (result.ok) return false;
  res.status(result.status).json({ error: result.error });
  return true;
}

function notFound(res: Response) {
  res.status(404).json({ error: TRIGGER_MESSAGES.notFound });
}

export function createTriggersRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/agents/:id/triggers", async (req, res) => {
    const { id } = parseRequest(ListAgentTriggersParams, req.params);
    const [agent] = await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
    if (!agent) {
      res.status(404).json({ error: TRIGGER_MESSAGES.agentNotFound });
      return;
    }
    const rows = await db
      .select()
      .from(agentTriggersTable)
      .where(eq(agentTriggersTable.agentId, id))
      .orderBy(asc(agentTriggersTable.id));
    res.json(ListAgentTriggersResponse.parse(rows.map(serializeTrigger)));
  });

  router.post("/agents/:id/triggers", async (req, res) => {
    const { id } = parseRequest(CreateAgentTriggerParams, req.params);
    const body = parseRequest(CreateAgentTriggerBody, req.body);
    const result = await createTrigger(id, currentUserId(req), body);
    if (sendFailure(res, result)) return;
    const { trigger, webhookUrl } = result.value;
    res.status(201).json(CreateAgentTriggerResponse.parse({ ...serializeTrigger(trigger), webhookUrl }));
  });

  // Il limite si consuma prima della validazione: ogni prova conta, anche quelle rifiutate.
  router.post("/agents/:id/triggers/test", triggerTestRateLimit, async (req, res) => {
    const { id } = parseRequest(TestAgentTriggerConfigParams, req.params);
    const body = parseRequest(TestAgentTriggerConfigBody, req.body);
    const result = await testTriggerConfig(id, body);
    if (sendFailure(res, result)) return;
    res.json(TestAgentTriggerConfigResponse.parse(result.value));
  });

  router.get("/triggers/:id", async (req, res) => {
    const { id } = parseRequest(GetTriggerParams, req.params);
    const trigger = await loadTrigger(id);
    if (!trigger) return notFound(res);
    res.json(GetTriggerResponse.parse(serializeTrigger(trigger)));
  });

  router.patch("/triggers/:id", async (req, res) => {
    const { id } = parseRequest(UpdateTriggerParams, req.params);
    const body = parseRequest(UpdateTriggerBody, req.body);
    const result = await updateTrigger(id, body);
    if (sendFailure(res, result)) return;
    res.json(UpdateTriggerResponse.parse(serializeTrigger(result.value)));
  });

  router.delete("/triggers/:id", async (req, res) => {
    const { id } = parseRequest(DeleteTriggerParams, req.params);
    if (!(await deleteTrigger(id))) return notFound(res);
    res.status(204).end();
  });

  router.post("/triggers/:id/pause", async (req, res) => {
    const { id } = parseRequest(PauseTriggerParams, req.params);
    const trigger = await pauseTrigger(id);
    if (!trigger) return notFound(res);
    res.json(PauseTriggerResponse.parse(serializeTrigger(trigger)));
  });

  router.post("/triggers/:id/resume", async (req, res) => {
    const { id } = parseRequest(ResumeTriggerParams, req.params);
    const trigger = await resumeTrigger(id);
    if (!trigger) return notFound(res);
    res.json(ResumeTriggerResponse.parse(serializeTrigger(trigger)));
  });

  router.post("/triggers/:id/test", triggerTestRateLimit, async (req, res) => {
    const { id } = parseRequest(TestTriggerParams, req.params);
    const result = await testSavedTrigger(id);
    if (sendFailure(res, result)) return;
    res.json(TestTriggerResponse.parse(result.value));
  });

  router.post("/triggers/:id/secret", sessionOnly, async (req, res) => {
    const { id } = parseRequest(RegenerateTriggerSecretParams, req.params);
    const result = await regenerateWebhookSecret(id);
    if (sendFailure(res, result)) return;
    res.json(RegenerateTriggerSecretResponse.parse({ webhookUrl: result.value }));
  });

  router.put("/triggers/:id/signing-secret", sessionOnly, async (req, res) => {
    const { id } = parseRequest(SetTriggerSigningSecretParams, req.params);
    const { secret } = parseRequest(SetTriggerSigningSecretBody, req.body);
    const result = await setSigningSecret(id, secret);
    if (sendFailure(res, result)) return;
    res.json(SetTriggerSigningSecretResponse.parse(serializeTrigger(result.value)));
  });

  router.get("/triggers/:id/runs", async (req, res) => {
    const { id } = parseRequest(ListTriggerRunsParams, req.params);
    if (!(await loadTrigger(id))) return notFound(res);
    const runs = await db
      .select()
      .from(runsTable)
      .where(eq(runsTable.triggerId, id))
      .orderBy(desc(runsTable.id))
      .limit(RUNS_PER_TRIGGER);
    res.json(ListTriggerRunsResponse.parse(await toPublicRuns(runs)));
  });

  return router;
}

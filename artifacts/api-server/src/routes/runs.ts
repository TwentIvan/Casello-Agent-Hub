import { z } from "zod";
import { Router, type IRouter } from "express";
import { eq, and, lt, asc, desc } from "drizzle-orm";
import { db, runsTable, runStepsTable } from "@workspace/db";
import {
  ListRunsQueryParams,
  ListRunsResponse,
  GetRunParams,
  GetRunResponse,
  ListRunStepsParams,
  ListRunStepsResponse,
  CancelRunParams,
  CancelRunResponse,
  SubmitRunClientResultParams,
  SubmitRunClientResultBody,
  ListRunMessagesParams,
  ListRunMessagesResponse,
  CreateRunMessageParams,
  CreateRunMessageResponse,
} from "@workspace/api-zod";
import { cancelRateLimit, runMessageRateLimit } from "../middlewares/rate-limit";
import { RUN_MESSAGE_MESSAGES, createRunMessage, listRunMessages } from "../lib/run-messages";
import { cancelRun } from "../lib/run-executor";
import { CLIENT_ACTION_MESSAGES, CLIENT_RESULT_MAX_CHARS, submitClientResult } from "../lib/client-actions";
import { readRunActivity } from "../lib/live/run-activity";
import { toPublicRun, toPublicRuns, triggerNamesFor } from "./serializers";
import { parseRequest } from "../middlewares/error-handler";

// Il codegen non emette .int() per i parametri integer: cursore e limite si restringono qui.
const ListRunsQuery = ListRunsQueryParams.extend({
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const router: IRouter = Router();

router.get("/runs", async (req, res) => {
  const { agentId, status, limit, before } = parseRequest(ListRunsQuery, req.query);
  const conditions = [
    ...(agentId !== undefined ? [eq(runsTable.agentId, agentId)] : []),
    ...(status !== undefined ? [eq(runsTable.status, status)] : []),
    ...(before !== undefined ? [lt(runsTable.id, before)] : []),
  ];
  const runs = await db
    .select()
    .from(runsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(runsTable.id))
    .limit(limit);
  res.json(ListRunsResponse.parse(await toPublicRuns(runs)));
});

router.get("/runs/:id", async (req, res) => {
  const { id } = parseRequest(GetRunParams, req.params);
  const [run] = await db.select().from(runsTable).where(eq(runsTable.id, id)).limit(1);
  if (!run) {
    res.status(404).json({ error: "Esecuzione non trovata" });
    return;
  }
  const children = await db
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(eq(runsTable.parentRunId, id))
    .orderBy(asc(runsTable.id));
  const names = await triggerNamesFor([run]);
  const triggerName = run.triggerId !== null ? (names.get(run.triggerId) ?? null) : null;
  // Attività in corso (issue #118): solo mentre la run lavora e la esegue questo processo
  const activity = run.status === "running" || run.status === "awaiting_client" ? readRunActivity(run.id) : null;
  res.json(
    GetRunResponse.parse({ ...toPublicRun(run, { childRunIds: children.map((c) => c.id), triggerName }), activity }),
  );
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

// Annullamento: UPDATE condizionato (pending/running → cancelled) e poi interruzione
// delle chiamate in volo. Una run già conclusa risponde 409.
router.post("/runs/:id/cancel", cancelRateLimit, async (req, res) => {
  const { id } = parseRequest(CancelRunParams, req.params);
  const result = await cancelRun(id);
  if (result.kind === "not_found") {
    res.status(404).json({ error: "Esecuzione non trovata" });
    return;
  }
  if (result.kind === "concluded") {
    res.status(409).json({ error: "L'esecuzione è già conclusa: non si può annullare." });
    return;
  }
  const [publicRun] = await toPublicRuns([result.run]);
  res.json(CancelRunResponse.parse(publicRun));
});

// Istruzioni a una run in corso (issue #119): il ciclo dell'agente le legge tra un passo e l'altro.
router.get("/runs/:id/messages", async (req, res) => {
  const { id } = parseRequest(ListRunMessagesParams, req.params);
  const [run] = await db.select({ id: runsTable.id }).from(runsTable).where(eq(runsTable.id, id)).limit(1);
  if (!run) {
    res.status(404).json({ error: RUN_MESSAGE_MESSAGES.runNotFound });
    return;
  }
  res.json(ListRunMessagesResponse.parse(await listRunMessages(id)));
});

// La lunghezza la controlla il servizio dopo la pulizia del testo, con il suo messaggio
const RunMessageBody = z.object({ content: z.string().max(10_000) });

router.post("/runs/:id/messages", runMessageRateLimit, async (req, res) => {
  const { id } = parseRequest(CreateRunMessageParams, req.params);
  const { content } = parseRequest(RunMessageBody, req.body);
  const result = await createRunMessage(id, req.userId ?? null, content);
  if (result.kind === "not_found") {
    res.status(404).json({ error: RUN_MESSAGE_MESSAGES.runNotFound });
    return;
  }
  if (result.kind === "invalid") {
    res.status(400).json({ error: result.message });
    return;
  }
  if (result.kind === "conflict") {
    res.status(409).json({ error: result.message });
    return;
  }
  res.status(201).json(CreateRunMessageResponse.parse(result.message));
});

// Esito di un'azione ui eseguita dal client (protocollo in lib/client-actions.ts): una volta sola, solo per
// l'azione che la run sta aspettando.
const ClientResultBody = SubmitRunClientResultBody.extend({
  actionId: z.string().min(1).max(100),
  result: z.string().max(CLIENT_RESULT_MAX_CHARS).nullish(),
});

router.post("/runs/:id/client-result", async (req, res) => {
  const { id } = parseRequest(SubmitRunClientResultParams, req.params);
  const body = parseRequest(ClientResultBody, req.body);
  const outcome = await submitClientResult(id, body);
  if (outcome.kind === "not_found") {
    res.status(404).json({ error: CLIENT_ACTION_MESSAGES.runNotFound });
    return;
  }
  if (outcome.kind === "not_waiting") {
    res.status(409).json({ error: CLIENT_ACTION_MESSAGES.notWaiting });
    return;
  }
  res.status(204).end();
});

export default router;

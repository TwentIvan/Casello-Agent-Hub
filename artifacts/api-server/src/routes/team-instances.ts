import express, { Router, type IRouter, type RequestHandler, type Response } from "express";
import {
  ListTeamInstancesQueryParams,
  ListTeamInstancesResponse,
  CreateTeamInstanceBody,
  GetTeamInstanceParams,
  GetTeamInstanceResponse,
  SaveTeamInstanceParams,
  SaveTeamInstanceBody,
  SaveTeamInstanceResponse,
  CloseTeamInstanceParams,
  CloseTeamInstanceResponse,
  CreateTeamInstanceResponse,
  GetTeamInstanceUpdatesParams,
  GetTeamInstanceUpdatesResponse,
  ApplyTeamInstanceUpdatesParams,
  ApplyTeamInstanceUpdatesBody,
  ApplyTeamInstanceUpdatesResponse,
  SaveTeamInstanceAsTemplateParams,
  SaveTeamInstanceAsTemplateBody,
  SaveTeamInstanceAsTemplateResponse,
  GetTeamPlanParams,
  GetTeamPlanResponse,
  SaveTeamPlanParams,
  SaveTeamPlanBody,
  SaveTeamPlanResponse,
  MarkTeamManualActionDoneParams,
  MarkTeamManualActionDoneResponse,
  ActivateTeamInstanceParams,
  ActivateTeamInstanceResponse,
  SendTeamMessageParams,
  SendTeamMessageBody,
  SendTeamMessageResponse,
  SetTeamBudgetParams,
  SetTeamBudgetBody,
  SetTeamBudgetResponse,
  ListTeamTasksParams,
  ListTeamTasksResponse,
  GetTeamTaskParams,
  GetTeamTaskResponse,
  ListTeamTurnsParams,
  ListTeamTurnsResponse,
  ListTeamEventsParams,
  ListTeamEventsResponse,
  ListUnreadTeamEventsResponse,
  MarkTeamEventsReadBody,
  MarkTeamEventsReadResponse,
  ListTeamAttachmentsParams,
  ListTeamAttachmentsResponse,
  UploadTeamAttachmentParams,
  UploadTeamAttachmentHeader,
  UploadTeamAttachmentResponse,
  GetTeamAttachmentParams,
  DeleteTeamAttachmentParams,
} from "@workspace/api-zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, nodesTable, teamCodeTasksTable, teamTaskStepsTable, teamTasksTable, teamTurnStepsTable, teamTurnsTable, type TeamTaskRow, type TeamTurnRow } from "@workspace/db";
import { currentUserId } from "../lib/auth";
import { AttachmentError, MAX_ATTACHMENT_BYTES, rfc5987, deleteAttachment, getAttachment, listAttachments, saveAttachment } from "../lib/teams/attachments";
import { InstanceError, closeInstance, createInstance, getInstance, listInstances, saveInstance, setInstanceBudget } from "../lib/teams/instances";
import { listEvents, markRead, userEvents } from "../lib/teams/events";
import { activateInstance, sendToLead } from "../lib/teams/turn-runner";
import { teamMessageRateLimit } from "../middlewares/rate-limit";
import { toNumberOrNull } from "./serializers";
import { SkillError } from "../lib/teams/skills";
import { correctPlan, getPlan, markManualActionDone } from "../lib/teams/plan";
import { saveInstanceAsTemplate } from "../lib/teams/save-as-template";
import { TeamRuleError } from "../lib/teams/rules";
import { TemplateError } from "../lib/teams/templates";
import { applyUpdates, getUpdates } from "../lib/teams/updates";
import { parseRequest } from "../middlewares/error-handler";

// Squadre (istanze di modelli) legate a un lavoro. Con un token personale valgono gli ambiti per metodo.

/** Esegue la richiesta e traduce le violazioni delle regole e gli errori di istanza/modello nel loro stato HTTP. */
async function guarded(res: Response, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof TeamRuleError) && !(err instanceof TemplateError) && !(err instanceof InstanceError) && !(err instanceof SkillError) && !(err instanceof AttachmentError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

/**
 * Lettura del file come Buffer, solo in memoria, qualunque sia il tipo di contenuto. Si monta soltanto sulla route del
 * caricamento: oltre 10 MB il parser lancia `entity.too.large` e l'error handler risponde 413 «allegato troppo grande».
 */
function attachmentUpload(): RequestHandler {
  return express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES });
}

/** Nome dal header `X-Attachment-Name`: decodificato se è codificato con encodeURIComponent, altrimenti com'è. */
function attachmentName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const router: IRouter = Router();

router.get("/team-instances", async (req, res) => {
  const filter = parseRequest(ListTeamInstancesQueryParams, req.query);
  res.json(ListTeamInstancesResponse.parse(await listInstances(filter)));
});

router.post("/team-instances", async (req, res) => {
  const body = parseRequest(CreateTeamInstanceBody, req.body);
  await guarded(res, async () => {
    res.status(201).json(CreateTeamInstanceResponse.parse(await createInstance(currentUserId(req), body)));
  });
});

router.get("/team-instances/:id", async (req, res) => {
  const { id } = parseRequest(GetTeamInstanceParams, req.params);
  await guarded(res, async () => {
    res.json(GetTeamInstanceResponse.parse(await getInstance(id)));
  });
});

router.put("/team-instances/:id", async (req, res) => {
  const { id } = parseRequest(SaveTeamInstanceParams, req.params);
  const body = parseRequest(SaveTeamInstanceBody, req.body);
  await guarded(res, async () => {
    res.json(SaveTeamInstanceResponse.parse(await saveInstance(currentUserId(req), id, body)));
  });
});

router.get("/team-instances/:id/attachments", async (req, res) => {
  const { id } = parseRequest(ListTeamAttachmentsParams, req.params);
  await guarded(res, async () => {
    await getInstance(id);
    res.json(ListTeamAttachmentsResponse.parse(await listAttachments(id)));
  });
});

router.post("/team-instances/:id/attachments", attachmentUpload(), async (req, res) => {
  const { id } = parseRequest(UploadTeamAttachmentParams, req.params);
  const header = parseRequest(UploadTeamAttachmentHeader, { "X-Attachment-Name": req.get("x-attachment-name") });
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  await guarded(res, async () => {
    await getInstance(id);
    const view = await saveAttachment(currentUserId(req), id, {
      name: attachmentName(header["X-Attachment-Name"]),
      contentType: req.get("content-type") ?? "",
      bytes,
    });
    res.status(201).json(UploadTeamAttachmentResponse.parse(view));
  });
});

router.get("/team-instances/:id/attachments/:attachmentId", async (req, res) => {
  const { id, attachmentId } = parseRequest(GetTeamAttachmentParams, req.params);
  await guarded(res, async () => {
    const row = await getAttachment(id, attachmentId);
    // Scaricato, mai mostrato nella pagina: un file HTML caricato non deve girare con l'origine della console
    res.set({
      "Content-Type": row.contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${rfc5987(row.name)}`,
      "X-Content-Type-Options": "nosniff",
    });
    res.send(row.content);
  });
});

router.delete("/team-instances/:id/attachments/:attachmentId", async (req, res) => {
  const { id, attachmentId } = parseRequest(DeleteTeamAttachmentParams, req.params);
  await guarded(res, async () => {
    await deleteAttachment(id, attachmentId);
    res.status(204).end();
  });
});

router.post("/team-instances/:id/close", async (req, res) => {
  const { id } = parseRequest(CloseTeamInstanceParams, req.params);
  await guarded(res, async () => {
    res.json(CloseTeamInstanceResponse.parse(await closeInstance(id)));
  });
});

router.get("/team-instances/:id/updates", async (req, res) => {
  const { id } = parseRequest(GetTeamInstanceUpdatesParams, req.params);
  await guarded(res, async () => {
    res.json(GetTeamInstanceUpdatesResponse.parse({ items: await getUpdates(id) }));
  });
});

router.post("/team-instances/:id/updates/apply", async (req, res) => {
  const { id } = parseRequest(ApplyTeamInstanceUpdatesParams, req.params);
  const { ids } = parseRequest(ApplyTeamInstanceUpdatesBody, req.body);
  if (new Set(ids).size !== ids.length) {
    res.status(400).json({ error: "aggiornamenti ripetuti" });
    return;
  }
  await guarded(res, async () => {
    res.json(ApplyTeamInstanceUpdatesResponse.parse(await applyUpdates(currentUserId(req), id, ids)));
  });
});

router.post("/team-instances/:id/save-as-template", async (req, res) => {
  const { id } = parseRequest(SaveTeamInstanceAsTemplateParams, req.params);
  const body = parseRequest(SaveTeamInstanceAsTemplateBody, req.body);
  await guarded(res, async () => {
    res.status(201).json(SaveTeamInstanceAsTemplateResponse.parse(await saveInstanceAsTemplate(currentUserId(req), id, body)));
  });
});

// Stato di branch, PR e CI dei compiti che hanno scritto codice, da affiancare al PLAN
async function withCodeTasks<T extends object>(instanceId: number, plan: T) {
  const rows = await db.select().from(teamCodeTasksTable).where(eq(teamCodeTasksTable.instanceId, instanceId)).orderBy(teamCodeTasksTable.id);
  return {
    ...plan,
    codeTasks: rows.map((r) => ({
      planTaskId: r.planTaskId,
      repo: r.repo,
      branch: r.branch,
      baseBranch: r.baseBranch,
      prNumber: r.prNumber,
      prUrl: r.prUrl,
      prState: r.prState,
      ciState: r.ciState,
      ciSummary: r.ciSummary,
      ciCheckedAt: r.ciCheckedAt ? r.ciCheckedAt.toISOString() : null,
    })),
  };
}

router.get("/team-instances/:id/plan", async (req, res) => {
  const { id } = parseRequest(GetTeamPlanParams, req.params);
  await guarded(res, async () => {
    await getInstance(id);
    res.json(GetTeamPlanResponse.parse(await withCodeTasks(id, await getPlan(id))));
  });
});

router.put("/team-instances/:id/plan", async (req, res) => {
  const { id } = parseRequest(SaveTeamPlanParams, req.params);
  const body = parseRequest(SaveTeamPlanBody, req.body);
  await guarded(res, async () => {
    const plan = { ...body, manualActions: body.manualActions.map((a) => ({ ...a, doneAt: a.doneAt ? a.doneAt.toISOString() : null })) };
    res.json(SaveTeamPlanResponse.parse(await withCodeTasks(id, await correctPlan(id, plan))));
  });
});

router.post("/team-instances/:id/plan/manual-actions/:actionId/done", async (req, res) => {
  const { id, actionId } = parseRequest(MarkTeamManualActionDoneParams, req.params);
  await guarded(res, async () => {
    res.json(MarkTeamManualActionDoneResponse.parse(await withCodeTasks(id, await markManualActionDone(id, actionId))));
  });
});

// ─── Esecuzione: attivazione, messaggi al capo, tetto, attività, bollettino ──

const MAX_TURNS = 50;
const MAX_TASKS = 200;
const MAX_USER_EVENTS = 200;

// Mai la lease (`leaseToken`): al nodo serve solo a lui, la console vede nodo, scadenza e sessione
const publicTask = ({ costUsd, leaseToken: _leaseToken, ...rest }: TeamTaskRow, nodeName: string | null) => ({
  ...rest,
  costUsd: toNumberOrNull(costUsd),
  nodeName,
});
const publicTurn = ({ costUsd, ...rest }: TeamTurnRow) => ({ ...rest, costUsd: toNumberOrNull(costUsd) });

router.post("/team-instances/:id/activate", async (req, res) => {
  const { id } = parseRequest(ActivateTeamInstanceParams, req.params);
  await guarded(res, async () => {
    res.json(ActivateTeamInstanceResponse.parse(await activateInstance(currentUserId(req), id)));
  });
});

router.post("/team-instances/:id/messages", teamMessageRateLimit, async (req, res) => {
  const { id } = parseRequest(SendTeamMessageParams, req.params);
  const { text } = parseRequest(SendTeamMessageBody, req.body);
  if (text.trim() === "") {
    res.status(400).json({ error: "messaggio vuoto" });
    return;
  }
  await guarded(res, async () => {
    await sendToLead(currentUserId(req), id, text.trim());
    res.status(202).json(SendTeamMessageResponse.parse({ queued: true }));
  });
});

router.put("/team-instances/:id/budget", async (req, res) => {
  const { id } = parseRequest(SetTeamBudgetParams, req.params);
  const { monthlyBudgetUsd } = parseRequest(SetTeamBudgetBody, req.body);
  await guarded(res, async () => {
    res.json(SetTeamBudgetResponse.parse(await setInstanceBudget(id, monthlyBudgetUsd)));
  });
});

router.get("/team-instances/:id/tasks", async (req, res) => {
  const { id } = parseRequest(ListTeamTasksParams, req.params);
  await guarded(res, async () => {
    await getInstance(id);
    const rows = await db
      .select({ task: teamTasksTable, nodeName: nodesTable.name })
      .from(teamTasksTable)
      .leftJoin(nodesTable, eq(nodesTable.id, teamTasksTable.nodeId))
      .where(eq(teamTasksTable.instanceId, id))
      .orderBy(desc(teamTasksTable.id))
      .limit(MAX_TASKS);
    res.json(ListTeamTasksResponse.parse(rows.map((r) => publicTask(r.task, r.nodeName))));
  });
});

router.get("/team-instances/:id/tasks/:taskId", async (req, res) => {
  const { id, taskId } = parseRequest(GetTeamTaskParams, req.params);
  await guarded(res, async () => {
    const [found] = await db
      .select({ task: teamTasksTable, nodeName: nodesTable.name })
      .from(teamTasksTable)
      .leftJoin(nodesTable, eq(nodesTable.id, teamTasksTable.nodeId))
      .where(and(eq(teamTasksTable.id, taskId), eq(teamTasksTable.instanceId, id)))
      .limit(1);
    const row = found?.task;
    if (!row) throw new InstanceError(404, "compito non trovato");
    const steps = await db.select().from(teamTaskStepsTable).where(eq(teamTaskStepsTable.taskId, row.id)).orderBy(teamTaskStepsTable.position);
    res.json(GetTeamTaskResponse.parse({ ...publicTask(row, found.nodeName), steps: steps.map(({ taskId: _taskId, ...step }) => step) }));
  });
});

router.get("/team-instances/:id/turns", async (req, res) => {
  const { id } = parseRequest(ListTeamTurnsParams, req.params);
  await guarded(res, async () => {
    await getInstance(id);
    const rows = await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, id)).orderBy(desc(teamTurnsTable.id)).limit(MAX_TURNS);
    const steps =
      rows.length === 0
        ? []
        : await db
            .select()
            .from(teamTurnStepsTable)
            .where(inArray(teamTurnStepsTable.turnId, rows.map((r) => r.id)))
            .orderBy(teamTurnStepsTable.turnId, teamTurnStepsTable.position);
    res.json(
      ListTeamTurnsResponse.parse(
        rows.map((turn) => ({ ...publicTurn(turn), steps: steps.filter((s) => s.turnId === turn.id).map(({ turnId: _turnId, ...step }) => step) })),
      ),
    );
  });
});

router.get("/team-instances/:id/events", async (req, res) => {
  const { id } = parseRequest(ListTeamEventsParams, req.params);
  await guarded(res, async () => {
    await getInstance(id);
    res.json(ListTeamEventsResponse.parse(await listEvents(id)));
  });
});

router.get("/team-events", async (req, res) => {
  // `unread` si legge come testo: la coercizione booleana tratterebbe "false" come vero
  const raw = req.query["unread"];
  if (raw !== undefined && raw !== "true" && raw !== "false") {
    res.status(400).json({ error: "unread deve essere true o false" });
    return;
  }
  const unread = raw === "true";
  const rows = await userEvents(currentUserId(req), { unread, limit: MAX_USER_EVENTS });
  res.json(ListUnreadTeamEventsResponse.parse(rows));
});

router.post("/team-events/read", async (req, res) => {
  const { ids } = parseRequest(MarkTeamEventsReadBody, req.body);
  res.json(MarkTeamEventsReadResponse.parse({ updated: await markRead(currentUserId(req), ids) }));
});

export default router;

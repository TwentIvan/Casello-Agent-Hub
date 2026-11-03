import { Router, type IRouter, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  ApprovePendingActionBody,
  ApprovePendingActionParams,
  ApprovePendingActionResponse,
  GetPendingActionParams,
  GetPendingActionResponse,
  ListPendingActionsQueryParams,
  ListPendingActionsResponse,
  RejectPendingActionBody,
  RejectPendingActionParams,
  RejectPendingActionResponse,
} from "@workspace/api-zod";
import { db, appToolsTable, appsTable, pendingActionsTable } from "@workspace/db";
import { ACTION_MESSAGES, approveAction, rejectAction, type DecideResult } from "../lib/actions/decide";
import { currentUserId } from "../lib/auth";
import { actionDecideRateLimit } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";

// Coda delle azioni L2: elenco, dettaglio, approvazione (esegue la chiamata memorizzata) e rifiuto.
// Le voci sono sempre dell'utente corrente: quelle di altri risultano inesistenti (404).

const MAX_LIST = 200;

const selectQueued = () =>
  db
    .select({
      action: pendingActionsTable,
      appName: appsTable.name,
      toolName: appToolsTable.name,
      toolIdentity: appToolsTable.identity,
    })
    .from(pendingActionsTable)
    .innerJoin(appsTable, eq(appsTable.id, pendingActionsTable.appId))
    .innerJoin(appToolsTable, eq(appToolsTable.id, pendingActionsTable.toolId));

type QueuedRow = Awaited<ReturnType<typeof selectQueued>>[number];

function toQueuedAction({ action, appName, toolName, toolIdentity }: QueuedRow) {
  return {
    number: action.number,
    status: action.status,
    app: { id: action.appId, name: appName },
    tool: { id: action.toolId, name: toolName, identity: toolIdentity },
    agentId: action.agentId,
    runId: action.runId,
    recipient: action.recipient,
    summary: action.summary,
    args: action.argsPublic,
    result: action.result,
    errorMessage: action.errorMessage,
    decisionNote: action.decisionNote,
    createdAt: action.createdAt,
    decidedAt: action.decidedAt,
    finishedAt: action.finishedAt,
  };
}

async function loadQueued(userId: number, number: number) {
  const [row] = await selectQueued()
    .where(and(eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.number, number)))
    .limit(1);
  return row;
}

export function createPendingActionsRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/pending-actions", async (req, res) => {
    const { status } = parseRequest(ListPendingActionsQueryParams, req.query);
    const userId = currentUserId(req);
    const rows = await selectQueued()
      .where(
        status === "all"
          ? eq(pendingActionsTable.userId, userId)
          : and(eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.status, status)),
      )
      .orderBy(desc(pendingActionsTable.number))
      .limit(MAX_LIST);
    res.json(ListPendingActionsResponse.parse({ actions: rows.map(toQueuedAction) }));
  });

  router.get("/pending-actions/:number", async (req, res) => {
    const { number } = parseRequest(GetPendingActionParams, req.params);
    const row = await loadQueued(currentUserId(req), number);
    if (!row) {
      res.status(404).json({ error: ACTION_MESSAGES.notFound });
      return;
    }
    res.json(GetPendingActionResponse.parse(toQueuedAction(row)));
  });

  // Dopo la decisione la risposta è la voce completa; `decided.ok = false` porta lo stato HTTP dell'errore
  async function respond(res: Response, userId: number, decided: DecideResult, parse: (v: unknown) => unknown) {
    if (!decided.ok) {
      res.status(decided.status).json({ error: decided.message });
      return;
    }
    const row = await loadQueued(userId, decided.action.number);
    res.json(parse(toQueuedAction(row!)));
  }

  router.post("/pending-actions/:number/approve", actionDecideRateLimit, async (req, res) => {
    const { number } = parseRequest(ApprovePendingActionParams, req.params);
    const body = parseRequest(ApprovePendingActionBody, req.body ?? {});
    const userId = currentUserId(req);
    const decided = await approveAction(userId, number, body.userToken !== undefined ? { userToken: body.userToken } : {});
    await respond(res, userId, decided, (v) => ApprovePendingActionResponse.parse(v));
  });

  router.post("/pending-actions/:number/reject", actionDecideRateLimit, async (req, res) => {
    const { number } = parseRequest(RejectPendingActionParams, req.params);
    const body = parseRequest(RejectPendingActionBody, req.body ?? {});
    const userId = currentUserId(req);
    const decided = await rejectAction(userId, number, body.note ?? null);
    await respond(res, userId, decided, (v) => RejectPendingActionResponse.parse(v));
  });

  return router;
}

import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import {
  db,
  aiModelsTable,
  analysesTable,
  analysisItemsTable,
  appsTable,
  modelOffersTable,
  planConversationsTable,
  planMessagesTable,
  planProposalsTable,
  type PlanConversation,
  type PlanProposal,
} from "@workspace/db";
import {
  GetAppPlanParams,
  GetAppPlanResponse,
  ListPlanConversationsParams,
  ListPlanConversationsResponse,
  CreatePlanConversationParams,
  CreatePlanConversationBody,
  GetPlanConversationParams,
  GetPlanConversationResponse,
  UpdatePlanConversationParams,
  UpdatePlanConversationBody,
  UpdatePlanConversationResponse,
  DeletePlanConversationParams,
  SendPlanMessageParams,
  SendPlanMessageBody,
  SendPlanMessageResponse,
  DecidePlanProposalParams,
  DecidePlanProposalBody,
  DecidePlanProposalResponse,
} from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { ModelChoiceError, chooseOwnModel } from "../lib/ai/choice";
import { effectiveStatus } from "../lib/ai/model-status";
import { itemTitle, type PlanChapter } from "../lib/plan-chat/context";
import { ProposalConflictError, ProposalNotFoundError, decideProposal } from "../lib/plan-chat/decide";
import { TurnBusyError, loadPlanItems, startPlanTurn } from "../lib/plan-chat/run-turn";
import { rateLimit } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";
import {
  toPublicItem,
  toPublicPlanConversation,
  toPublicPlanMessage,
  toPublicPlanProposal,
} from "./serializers";

// Route della chat del piano: conversazioni con il bot sul piano di un'app, messaggi (il turno del bot
// gira in background e la UI fa polling su GET /plan-conversations/:id) e decisione sulle proposte.
// Conversazioni e proposte sono visibili solo al loro proprietario: per gli altri 404.

const APP_NOT_FOUND = "App non trovata";
const CONVERSATION_NOT_FOUND = "Conversazione non trovata";
const NO_COMPLETED_ANALYSIS = "L'app non ha un'analisi completata";
const MODEL_UNAVAILABLE = "Il modello non è più disponibile: scegline un altro";
const TURN_RUNNING = "Il bot sta già rispondendo";

/** Conversazione dell'utente (404 per le altre). */
async function findConversation(id: number, userId: number): Promise<PlanConversation | undefined> {
  const [row] = await db
    .select()
    .from(planConversationsTable)
    .where(and(eq(planConversationsTable.id, id), eq(planConversationsTable.userId, userId)))
    .limit(1);
  return row;
}

async function appExists(id: number): Promise<boolean> {
  const [row] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, id)).limit(1);
  return row !== undefined;
}

/** Id dell'ultima analisi completata dell'app. */
async function latestCompletedAnalysisId(appId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: analysesTable.id })
    .from(analysesTable)
    .where(and(eq(analysesTable.appId, appId), eq(analysesTable.status, "completed")))
    .orderBy(desc(analysesTable.id))
    .limit(1);
  return row?.id ?? null;
}

/** Lo stato effettivo del modello (come la tendina) non è "disponibile". Un modello assente non blocca: ci pensa il turno. */
async function isModelUnavailable(aiModelId: number | null): Promise<boolean> {
  if (aiModelId === null) return false;
  const [row] = await db
    .select({ availability: aiModelsTable.availability, status: modelOffersTable.status, deprecationDate: modelOffersTable.deprecationDate })
    .from(aiModelsTable)
    .leftJoin(modelOffersTable, eq(aiModelsTable.offerId, modelOffersTable.id))
    .where(eq(aiModelsTable.id, aiModelId))
    .limit(1);
  if (!row) return false;
  const status = effectiveStatus(
    { availability: row.availability, catalogStatus: row.status ?? null, deprecationDate: row.deprecationDate ?? null },
    new Date(),
  );
  return status !== "available";
}

/** Proposte nella forma pubblica, col titolo della voce proposta o (discard) di quella di destinazione. */
async function publicProposals(proposals: PlanProposal[]) {
  const targetIds = proposals.map((p) => p.targetItemId).filter((id): id is number => id !== null);
  const targets = targetIds.length
    ? await db.select().from(analysisItemsTable).where(inArray(analysisItemsTable.id, targetIds))
    : [];
  const targetById = new Map(targets.map((t) => [t.id, t]));
  return proposals.map((p) => {
    const target = p.targetItemId === null ? undefined : targetById.get(p.targetItemId);
    const title =
      p.kind === "discard"
        ? target
          ? itemTitle(target.chapter as PlanChapter, target.payload)
          : "(voce rimossa)"
        : itemTitle(p.chapter as PlanChapter, p.payload);
    return toPublicPlanProposal(p, title);
  });
}

export function createPlanChatRouter(opts: { messageLimit?: number } = {}): IRouter {
  const router: IRouter = Router();
  // 10 messaggi al minuto per utente: ogni turno consuma token sul modello dell'utente
  const messageRateLimit = rateLimit({
    limit: opts.messageLimit ?? 10,
    windowMs: 60_000,
    key: (req) => String(currentUserId(req)),
  });

  router.get("/apps/:id/plan", async (req, res) => {
    const { id } = parseRequest(GetAppPlanParams, req.params);
    if (!(await appExists(id))) {
      res.status(404).json({ error: APP_NOT_FOUND });
      return;
    }
    const analysisId = await latestCompletedAnalysisId(id);
    const items = analysisId === null ? [] : await loadPlanItems(analysisId, id);
    res.json(GetAppPlanResponse.parse({ analysisId, items: items.map(toPublicItem) }));
  });

  router.get("/apps/:id/plan-conversations", async (req, res) => {
    const { id } = parseRequest(ListPlanConversationsParams, req.params);
    if (!(await appExists(id))) {
      res.status(404).json({ error: APP_NOT_FOUND });
      return;
    }
    const rows = await db
      .select()
      .from(planConversationsTable)
      .where(and(eq(planConversationsTable.appId, id), eq(planConversationsTable.userId, currentUserId(req))))
      .orderBy(desc(planConversationsTable.updatedAt), desc(planConversationsTable.id));
    res.json(ListPlanConversationsResponse.parse(rows.map(toPublicPlanConversation)));
  });

  router.post("/apps/:id/plan-conversations", async (req, res) => {
    const { id } = parseRequest(CreatePlanConversationParams, req.params);
    const body = parseRequest(CreatePlanConversationBody, req.body);
    const userId = currentUserId(req);
    if (!(await appExists(id))) {
      res.status(404).json({ error: APP_NOT_FOUND });
      return;
    }
    try {
      await chooseOwnModel(body.aiModelId, userId);
    } catch (err) {
      if (!(err instanceof ModelChoiceError)) throw err;
      res.status(400).json({ error: err.message });
      return;
    }
    if (await isModelUnavailable(body.aiModelId)) {
      res.status(400).json({ error: MODEL_UNAVAILABLE });
      return;
    }

    let analysisId: number | null;
    if (body.analysisId !== undefined) {
      // L'analisi indicata deve essere di questa app (404 altrimenti) e completata
      const [row] = await db
        .select({ id: analysesTable.id, status: analysesTable.status })
        .from(analysesTable)
        .where(and(eq(analysesTable.id, body.analysisId), eq(analysesTable.appId, id)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: "Analisi non trovata" });
        return;
      }
      analysisId = row.status === "completed" ? row.id : null;
    } else {
      analysisId = await latestCompletedAnalysisId(id);
    }
    if (analysisId === null) {
      res.status(409).json({ error: NO_COMPLETED_ANALYSIS });
      return;
    }

    const [conv] = await db
      .insert(planConversationsTable)
      .values({ appId: id, analysisId, userId, aiModelId: body.aiModelId, title: "" })
      .returning();
    res.status(201).json(toPublicPlanConversation(conv!));
  });

  router.get("/plan-conversations/:id", async (req, res) => {
    const { id } = parseRequest(GetPlanConversationParams, req.params);
    const conv = await findConversation(id, currentUserId(req));
    if (!conv) {
      res.status(404).json({ error: CONVERSATION_NOT_FOUND });
      return;
    }
    const messages = await db
      .select()
      .from(planMessagesTable)
      .where(eq(planMessagesTable.conversationId, id))
      .orderBy(asc(planMessagesTable.id));
    const proposals = await db
      .select()
      .from(planProposalsTable)
      .where(eq(planProposalsTable.conversationId, id))
      .orderBy(asc(planProposalsTable.id));
    const [newer] = await db
      .select({ id: analysesTable.id })
      .from(analysesTable)
      .where(and(eq(analysesTable.appId, conv.appId), eq(analysesTable.status, "completed"), gt(analysesTable.id, conv.analysisId)))
      .orderBy(desc(analysesTable.id))
      .limit(1);
    res.json(
      GetPlanConversationResponse.parse({
        ...toPublicPlanConversation(conv),
        messages: messages.map(toPublicPlanMessage),
        proposals: await publicProposals(proposals),
        newerAnalysisId: newer?.id ?? null,
      }),
    );
  });

  router.patch("/plan-conversations/:id", async (req, res) => {
    const { id } = parseRequest(UpdatePlanConversationParams, req.params);
    const { aiModelId } = parseRequest(UpdatePlanConversationBody, req.body);
    const userId = currentUserId(req);
    const conv = await findConversation(id, userId);
    if (!conv) {
      res.status(404).json({ error: CONVERSATION_NOT_FOUND });
      return;
    }
    if (conv.turnStatus !== "idle") {
      res.status(409).json({ error: TURN_RUNNING });
      return;
    }
    try {
      await chooseOwnModel(aiModelId, userId);
    } catch (err) {
      if (!(err instanceof ModelChoiceError)) throw err;
      res.status(400).json({ error: err.message });
      return;
    }
    if (await isModelUnavailable(aiModelId)) {
      res.status(400).json({ error: MODEL_UNAVAILABLE });
      return;
    }
    // Condizionato su idle: un turno partito nel frattempo non si perde il modello a metà
    const [updated] = await db
      .update(planConversationsTable)
      .set({ aiModelId, updatedAt: new Date() })
      .where(and(eq(planConversationsTable.id, id), eq(planConversationsTable.turnStatus, "idle")))
      .returning();
    if (!updated) {
      res.status(409).json({ error: TURN_RUNNING });
      return;
    }
    res.json(UpdatePlanConversationResponse.parse(toPublicPlanConversation(updated)));
  });

  router.delete("/plan-conversations/:id", async (req, res) => {
    const { id } = parseRequest(DeletePlanConversationParams, req.params);
    // Messaggi e proposte vanno a cascata; le voci accettate restano (conversation_id → null)
    const deleted = await db
      .delete(planConversationsTable)
      .where(and(eq(planConversationsTable.id, id), eq(planConversationsTable.userId, currentUserId(req))))
      .returning({ id: planConversationsTable.id });
    if (!deleted.length) {
      res.status(404).json({ error: CONVERSATION_NOT_FOUND });
      return;
    }
    res.status(204).end();
  });

  router.post("/plan-conversations/:id/messages", messageRateLimit, async (req, res) => {
    const { id } = parseRequest(SendPlanMessageParams, req.params);
    const body = parseRequest(SendPlanMessageBody, req.body);
    // Un messaggio di soli spazi non è un messaggio; titolo e cronologia usano il testo senza spazi ai bordi
    const content = body.content.trim();
    if (content === "") {
      res.status(400).json({ error: "Il messaggio è vuoto" });
      return;
    }
    const conv = await findConversation(id, currentUserId(req));
    if (!conv) {
      res.status(404).json({ error: CONVERSATION_NOT_FOUND });
      return;
    }
    if (await isModelUnavailable(conv.aiModelId)) {
      res.status(409).json({ error: MODEL_UNAVAILABLE });
      return;
    }
    try {
      const message = await startPlanTurn(id, content);
      res.status(202).json(SendPlanMessageResponse.parse(toPublicPlanMessage(message)));
    } catch (err) {
      if (!(err instanceof TurnBusyError)) throw err;
      res.status(409).json({ error: TURN_RUNNING });
    }
  });

  router.post("/plan-proposals/:id/decision", async (req, res) => {
    const { id } = parseRequest(DecidePlanProposalParams, req.params);
    const { action } = parseRequest(DecidePlanProposalBody, req.body);
    try {
      const { proposal, item } = await decideProposal(id, currentUserId(req), action);
      const [publicProposal] = await publicProposals([proposal]);
      res.json(DecidePlanProposalResponse.parse({ proposal: publicProposal, item: item ? toPublicItem(item) : null }));
    } catch (err) {
      if (err instanceof ProposalNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof ProposalConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}

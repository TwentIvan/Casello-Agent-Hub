import { readTurnProgress } from "../lib/turn-progress/progress";
import { Router, type IRouter, type Response } from "express";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import {
  db,
  characterConversationsTable,
  characterMessagesTable,
  characterProposalsTable,
  type CharacterConversation,
  type CharacterMessage,
} from "@workspace/db";
import {
  GetAlfredThreadResponse,
  RestartAlfredThreadResponse,
  ListCharacterConversationsQueryParams,
  ListCharacterConversationsResponse,
  CreateCharacterConversationBody,
  CreateCharacterConversationResponse,
  GetCharacterConversationParams,
  GetCharacterConversationResponse,
  UpdateCharacterConversationParams,
  UpdateCharacterConversationBody,
  UpdateCharacterConversationResponse,
  DeleteCharacterConversationParams,
  SendCharacterMessageParams,
  SendCharacterMessageBody,
  SendCharacterMessageResponse,
  DecideCharacterProposalParams,
  DecideCharacterProposalBody,
  DecideCharacterProposalResponse,
  StopCharacterTurnParams,
  StopCharacterTurnResponse,
  CancelQueuedCharacterMessageParams,
} from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { characterBudgetBlock } from "../lib/budget";
import { ownModel } from "../lib/ai/default-model";
import { createConversation, getConversation } from "../lib/characters/conversations";
import { decideCharacterProposal, toProposalView, type ProposalView } from "../lib/characters/proposals";
import { findSubject } from "../lib/characters/registry";
import { CHARACTER_CHAT_SPEC, TurnBusyError, startCharacterTurn } from "../lib/characters/run-turn";
import { cancelQueued, getQueued, sendChatMessage, stopChatTurn } from "../lib/chat-turns/control";
import { getAlfredThread, restartAlfredThread } from "../lib/characters/subjects/alfred-thread";
import { CHARACTER_MESSAGES, CHARACTER_MESSAGE_MAX_CHARS, CharacterError, type PageContext } from "../lib/characters/types";
import { consumeCharacterMessage, consumeTurnStop } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";
import { toNumberOrNull } from "./serializers";

// Route delle conversazioni scritte con Alfred e Lucius: dati dell'utente (per gli altri 404), turno in background
// con polling su GET /character-conversations/:id, decisione sulle schede. Con un token personale valgono gli
// ambiti per metodo (requireAuth).

const LIST_MAX = 100;
const TOO_MANY_STOPS = "Troppe richieste: riprova tra poco";

const toPublicConversation = (c: CharacterConversation) => {
  const { userId: _userId, summarizedAt: _summarizedAt, ...rest } = c;
  return { ...rest, costUsd: toNumberOrNull(c.costUsd) };
};

const toPublicMessage = (m: CharacterMessage) => {
  const { conversationId: _conversationId, tokens: _tokens, ...rest } = m;
  const pc = m.pageContext;
  return { ...rest, pageContext: typeof pc === "object" && pc !== null && !Array.isArray(pc) ? (pc as PageContext) : null };
};

const toPublicProposal = (p: ProposalView) => {
  const { conversationId: _conversationId, ...rest } = p;
  const payload = p.payload;
  return { ...rest, payload: typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : null };
};

/** L'argomento non si risolve più (oggetto eliminato o tipo non registrato); il filo di Alfred non ha oggetto. */
async function subjectGone(userId: number, conv: CharacterConversation): Promise<boolean> {
  if (conv.subjectType === "alfred_thread") return false;
  const handler = findSubject(conv.subjectType);
  if (!handler || handler.character !== conv.character) return true;
  return (await handler.resolve(userId, conv.subjectId)) === null;
}

async function detail(userId: number, conv: CharacterConversation) {
  // Il messaggio in coda non è ancora nella cronologia: si espone a parte (`queuedMessage`)
  const messages = await db
    .select()
    .from(characterMessagesTable)
    .where(and(eq(characterMessagesTable.conversationId, conv.id), isNull(characterMessagesTable.queuedAt)))
    .orderBy(asc(characterMessagesTable.id));
  const proposals = await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.conversationId, conv.id)).orderBy(asc(characterProposalsTable.id));
  return {
    ...toPublicConversation(conv),
    subjectGone: await subjectGone(userId, conv),
    messages: messages.map(toPublicMessage),
    progress: conv.turnStatus === "running" ? readTurnProgress("character", conv.id) : null,
    proposals: proposals.map((p) => toPublicProposal(toProposalView(p))),
    queuedMessage: await getQueued(CHARACTER_CHAT_SPEC, conv.id),
  };
}

/** Esegue la richiesta e traduce `CharacterError` nel suo stato HTTP. */
async function guarded(res: Response, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof CharacterError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

export function createCharactersRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/characters/alfred/thread", async (req, res) => {
    const userId = currentUserId(req);
    await guarded(res, async () => {
      const conv = await getAlfredThread(userId);
      res.json(GetAlfredThreadResponse.parse(await detail(userId, conv)));
    });
  });

  router.post("/characters/alfred/thread/restart", async (req, res) => {
    const userId = currentUserId(req);
    await guarded(res, async () => {
      const conv = await restartAlfredThread(userId);
      res.json(RestartAlfredThreadResponse.parse(await detail(userId, conv)));
    });
  });

  router.get("/character-conversations", async (req, res) => {
    const q = parseRequest(ListCharacterConversationsQueryParams, req.query);
    const conditions = [
      eq(characterConversationsTable.userId, currentUserId(req)),
      eq(characterConversationsTable.character, q.character),
      ne(characterConversationsTable.subjectType, "alfred_thread"),
    ];
    if (q.subjectType !== undefined) conditions.push(eq(characterConversationsTable.subjectType, q.subjectType));
    if (q.subjectId !== undefined) conditions.push(eq(characterConversationsTable.subjectId, q.subjectId));
    const rows = await db
      .select()
      .from(characterConversationsTable)
      .where(and(...conditions))
      .orderBy(desc(characterConversationsTable.updatedAt), desc(characterConversationsTable.id))
      .limit(LIST_MAX);
    res.json(ListCharacterConversationsResponse.parse(rows.map(toPublicConversation)));
  });

  router.post("/character-conversations", async (req, res) => {
    const body = parseRequest(CreateCharacterConversationBody, req.body);
    await guarded(res, async () => {
      const conv = await createConversation(currentUserId(req), body.character, body.subjectType, body.subjectId ?? null);
      res.status(201).json(CreateCharacterConversationResponse.parse(toPublicConversation(conv)));
    });
  });

  router.get("/character-conversations/:id", async (req, res) => {
    const { id } = parseRequest(GetCharacterConversationParams, req.params);
    const userId = currentUserId(req);
    await guarded(res, async () => {
      const conv = await getConversation(userId, id);
      res.json(GetCharacterConversationResponse.parse(await detail(userId, conv)));
    });
  });

  router.patch("/character-conversations/:id", async (req, res) => {
    const { id } = parseRequest(UpdateCharacterConversationParams, req.params);
    const body = parseRequest(UpdateCharacterConversationBody, req.body);
    const userId = currentUserId(req);
    await guarded(res, async () => {
      await getConversation(userId, id);
      const set: Partial<typeof characterConversationsTable.$inferInsert> = {};
      if (body.aiModelId !== undefined) {
        if (body.aiModelId !== null && !(await ownModel(userId, body.aiModelId, db))) {
          throw new CharacterError(400, CHARACTER_MESSAGES.modelUnavailable);
        }
        set.aiModelId = body.aiModelId;
      }
      if (body.title !== undefined) set.title = body.title;
      const [row] =
        Object.keys(set).length === 0
          ? await db.select().from(characterConversationsTable).where(eq(characterConversationsTable.id, id))
          : await db
              .update(characterConversationsTable)
              .set({ ...set, updatedAt: new Date() })
              .where(and(eq(characterConversationsTable.id, id), eq(characterConversationsTable.userId, userId)))
              .returning();
      if (!row) throw new CharacterError(404, CHARACTER_MESSAGES.notFound);
      res.json(UpdateCharacterConversationResponse.parse(toPublicConversation(row)));
    });
  });

  router.delete("/character-conversations/:id", async (req, res) => {
    const { id } = parseRequest(DeleteCharacterConversationParams, req.params);
    const userId = currentUserId(req);
    await guarded(res, async () => {
      const conv = await getConversation(userId, id);
      if (conv.subjectType === "alfred_thread" && conv.archivedAt === null) {
        throw new CharacterError(409, CHARACTER_MESSAGES.threadKeep);
      }
      // Messaggi e schede vanno a cascata
      const deleted = await db
        .delete(characterConversationsTable)
        .where(and(eq(characterConversationsTable.id, id), eq(characterConversationsTable.userId, userId)))
        .returning({ id: characterConversationsTable.id });
      if (!deleted.length) throw new CharacterError(404, CHARACTER_MESSAGES.notFound);
      res.status(204).end();
    });
  });

  router.post("/character-conversations/:id/messages", async (req, res) => {
    const { id } = parseRequest(SendCharacterMessageParams, req.params);
    const body = parseRequest(SendCharacterMessageBody, req.body);
    const userId = currentUserId(req);
    // Un messaggio di soli spazi non è un messaggio
    const content = body.content.trim();
    if (content === "") {
      res.status(400).json({ error: CHARACTER_MESSAGES.empty });
      return;
    }
    const page = body.pageContext ?? null;
    await guarded(res, async () => {
      const conv = await getConversation(userId, id);
      // Le regole dell'avvio del turno valgono anche per un messaggio che va in coda
      if (content.length > CHARACTER_MESSAGE_MAX_CHARS) throw new CharacterError(400, CHARACTER_MESSAGES.tooLong);
      if (page && (page.page === "host") !== (page.host !== undefined)) throw new CharacterError(400, CHARACTER_MESSAGES.badPageContext);
      if (conv.archivedAt !== null) throw new CharacterError(409, CHARACTER_MESSAGES.archived);
      if (await subjectGone(userId, conv)) throw new CharacterError(409, CHARACTER_MESSAGES.subjectGone);
      // Tetto raggiunto: 409 col motivo, prima di consumare il limite dei messaggi
      const blocked = await characterBudgetBlock(userId, conv.character, conv.aiModelId);
      if (blocked) {
        res.status(409).json({ error: blocked });
        return;
      }
      if (!consumeCharacterMessage(userId, conv.character)) {
        res.status(429).json({ error: CHARACTER_MESSAGES.tooMany });
        return;
      }
      try {
        const outcome = await sendChatMessage(CHARACTER_CHAT_SPEC, id, content, page, body.mode ?? "normal", () =>
          startCharacterTurn(id, content, page),
        );
        const message =
          outcome.kind === "started"
            ? toPublicMessage(outcome.message)
            : { ...outcome.queued, role: "user" as const, error: false, pageContext: page };
        res.status(202).json(SendCharacterMessageResponse.parse(message));
      } catch (err) {
        if (!(err instanceof TurnBusyError)) throw err;
        res.status(409).json({ error: CHARACTER_MESSAGES.busy });
      }
    });
  });

  router.post("/character-conversations/:id/stop", async (req, res) => {
    const { id } = parseRequest(StopCharacterTurnParams, req.params);
    const userId = currentUserId(req);
    await guarded(res, async () => {
      await getConversation(userId, id);
      if (!consumeTurnStop(userId)) {
        res.status(429).json({ error: TOO_MANY_STOPS });
        return;
      }
      const stopped = await stopChatTurn(CHARACTER_CHAT_SPEC, id);
      res.json(StopCharacterTurnResponse.parse({ stopped }));
    });
  });

  router.delete("/character-conversations/:id/queued", async (req, res) => {
    const { id } = parseRequest(CancelQueuedCharacterMessageParams, req.params);
    const userId = currentUserId(req);
    await guarded(res, async () => {
      await getConversation(userId, id);
      await cancelQueued(CHARACTER_CHAT_SPEC, id);
      res.status(204).end();
    });
  });

  router.post("/character-proposals/:id/decision", async (req, res) => {
    const { id } = parseRequest(DecideCharacterProposalParams, req.params);
    const { action } = parseRequest(DecideCharacterProposalBody, req.body);
    await guarded(res, async () => {
      const view = await decideCharacterProposal(currentUserId(req), id, action);
      res.json(DecideCharacterProposalResponse.parse(toPublicProposal(view)));
    });
  });

  return router;
}

import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetLeadChatResponse,
  ListLeadConversationsResponse,
  CreateLeadConversationResponse,
  GetLeadConversationParams,
  GetLeadConversationResponse,
  DeleteLeadConversationParams,
  SendLeadMessageParams,
  SendLeadMessageBody,
  SendLeadMessageResponse,
} from "@workspace/api-zod";
import { TOKEN_MESSAGES, currentUserId } from "../lib/auth";
import { LeadChatError } from "../lib/lead-chat/messages";
import {
  createLeadConversation,
  deleteLeadConversation,
  getLeadConversation,
  listLeadConversations,
  resolveLeadChat,
  sendLeadMessage,
} from "../lib/lead-chat/service";
import { parseRequest } from "../middlewares/error-handler";

// Chat con il Responsabile di prodotto di Botcave (scheda «Responsabile» del pannello, solo console). Dati dell'utente
// (per gli altri 404). Con un token personale valgono gli ambiti per metodo; i token d'ambito `agent` o `runs` e il
// pannello incorporato (`embed`) non la usano: 403.

/** Esegue la richiesta e traduce `LeadChatError` nel suo stato HTTP. */
async function handle(res: Response, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (!(err instanceof LeadChatError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

function deniedToken(req: Request): boolean {
  const auth = req.auth;
  if (auth?.kind !== "token") return false;
  return auth.via === "embed" || auth.scopes.some((s) => s === "agent" || s === "runs");
}

export function createLeadChatRouter(): IRouter {
  const router: IRouter = Router();

  router.use(["/lead-chat", "/lead-conversations"], (req, res, next) => {
    if (deniedToken(req)) {
      res.status(403).json({ error: TOKEN_MESSAGES.scope });
      return;
    }
    next();
  });

  router.get("/lead-chat", async (req, res) => {
    const a = await resolveLeadChat(currentUserId(req));
    res.json(GetLeadChatResponse.parse(a.available ? { ...a, reason: null } : a));
  });

  router.get("/lead-conversations", async (req, res) => {
    res.json(ListLeadConversationsResponse.parse(await listLeadConversations(currentUserId(req))));
  });

  router.post("/lead-conversations", async (req, res) => {
    await handle(res, async () => {
      const conv = await createLeadConversation(currentUserId(req));
      res.status(201).json(CreateLeadConversationResponse.parse({ ...conv, tokensUsed: 0, costUsd: 0 }));
    });
  });

  router.get("/lead-conversations/:id", async (req, res) => {
    const { id } = parseRequest(GetLeadConversationParams, req.params);
    await handle(res, async () => {
      res.json(GetLeadConversationResponse.parse(await getLeadConversation(currentUserId(req), id)));
    });
  });

  router.delete("/lead-conversations/:id", async (req, res) => {
    const { id } = parseRequest(DeleteLeadConversationParams, req.params);
    await handle(res, async () => {
      await deleteLeadConversation(currentUserId(req), id);
      res.status(204).end();
    });
  });

  router.post("/lead-conversations/:id/messages", async (req, res) => {
    const { id } = parseRequest(SendLeadMessageParams, req.params);
    const body = parseRequest(SendLeadMessageBody, req.body);
    await handle(res, async () => {
      // La pagina si ricontrolla sul corpo originale: campi in più → 400
      const raw = (req.body as { pageContext?: unknown }).pageContext;
      const sent = await sendLeadMessage(currentUserId(req), id, { content: body.content, pageContext: raw });
      res.status(202).json(SendLeadMessageResponse.parse(sent));
    });
  });

  return router;
}

import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetLeadChatQueryParams,
  GetLeadChatResponse,
  ListLeadConversationsQueryParams,
  CreateLeadConversationQueryParams,
  GetLeadConversationQueryParams,
  DeleteLeadConversationQueryParams,
  SendLeadMessageQueryParams,
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
import { HttpError } from "../lib/ai/node-account";
import { requireHostApp } from "../lib/embed/host-app";
import { LEAD_CHAT_MESSAGES, LeadChatError } from "../lib/lead-chat/messages";
import {
  createLeadConversation,
  deleteLeadConversation,
  getLeadConversation,
  leadConversationAppId,
  listLeadConversations,
  resolveLeadChat,
  sendLeadMessage,
} from "../lib/lead-chat/service";
import { parseRequest } from "../middlewares/error-handler";

// Chat con il Responsabile di prodotto di un'App (scheda «Responsabile» del pannello). `?app=<slug>` sceglie l'App
// (senza: `casello`); il pannello incorporato (`embed`) raggiunge solo l'App ospite del suo client, le altre → 404
// «App non trovata» (`requireHostApp`). Dati dell'utente (per gli altri 404); una conversazione di un'altra App → 404.
// Con un token personale valgono gli ambiti per metodo; i token d'ambito `agent` o `runs` non la usano: 403.

/** Esegue la richiesta e traduce `LeadChatError` e `HttpError` nel loro stato HTTP. */
async function handle(res: Response, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (!(err instanceof LeadChatError) && !(err instanceof HttpError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

function deniedToken(req: Request): boolean {
  const auth = req.auth;
  if (auth?.kind !== "token") return false;
  return auth.scopes.some((s) => s === "agent" || s === "runs");
}

/** La conversazione è dell'utente e dell'App richiesta, altrimenti 404. */
async function requireConversationOfApp(userId: number, id: number, appId: number): Promise<void> {
  if ((await leadConversationAppId(userId, id)) !== appId) throw new LeadChatError(404, LEAD_CHAT_MESSAGES.notFound);
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
    const { app: slug } = parseRequest(GetLeadChatQueryParams, req.query);
    await handle(res, async () => {
      const app = await requireHostApp(req, slug);
      const a = await resolveLeadChat(currentUserId(req), app.id);
      res.json(GetLeadChatResponse.parse(a.available ? { ...a, reason: null } : a));
    });
  });

  router.get("/lead-conversations", async (req, res) => {
    const { app: slug } = parseRequest(ListLeadConversationsQueryParams, req.query);
    await handle(res, async () => {
      const app = await requireHostApp(req, slug);
      res.json(ListLeadConversationsResponse.parse(await listLeadConversations(currentUserId(req), app.id)));
    });
  });

  router.post("/lead-conversations", async (req, res) => {
    const { app: slug } = parseRequest(CreateLeadConversationQueryParams, req.query);
    await handle(res, async () => {
      const app = await requireHostApp(req, slug);
      const conv = await createLeadConversation(currentUserId(req), app.id);
      res.status(201).json(CreateLeadConversationResponse.parse({ ...conv, tokensUsed: 0, costUsd: 0 }));
    });
  });

  router.get("/lead-conversations/:id", async (req, res) => {
    const { id } = parseRequest(GetLeadConversationParams, req.params);
    const { app: slug } = parseRequest(GetLeadConversationQueryParams, req.query);
    await handle(res, async () => {
      const app = await requireHostApp(req, slug);
      await requireConversationOfApp(currentUserId(req), id, app.id);
      res.json(GetLeadConversationResponse.parse(await getLeadConversation(currentUserId(req), id)));
    });
  });

  router.delete("/lead-conversations/:id", async (req, res) => {
    const { id } = parseRequest(DeleteLeadConversationParams, req.params);
    const { app: slug } = parseRequest(DeleteLeadConversationQueryParams, req.query);
    await handle(res, async () => {
      const app = await requireHostApp(req, slug);
      await requireConversationOfApp(currentUserId(req), id, app.id);
      await deleteLeadConversation(currentUserId(req), id);
      res.status(204).end();
    });
  });

  router.post("/lead-conversations/:id/messages", async (req, res) => {
    const { id } = parseRequest(SendLeadMessageParams, req.params);
    const { app: slug } = parseRequest(SendLeadMessageQueryParams, req.query);
    const body = parseRequest(SendLeadMessageBody, req.body);
    await handle(res, async () => {
      const app = await requireHostApp(req, slug);
      await requireConversationOfApp(currentUserId(req), id, app.id);
      // La pagina si ricontrolla sul corpo originale: campi in più → 400
      const raw = (req.body as { pageContext?: unknown }).pageContext;
      const sent = await sendLeadMessage(currentUserId(req), id, { content: body.content, pageContext: raw, actionLabel: body.actionLabel });
      res.status(202).json(SendLeadMessageResponse.parse(sent));
    });
  });

  return router;
}

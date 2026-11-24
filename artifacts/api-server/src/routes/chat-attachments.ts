// Allegati delle chat (issue #120): caricamento (file grezzo), scarico ed eliminazione di un allegato non mandato. Un
// solo meccanismo per le conversazioni dei personaggi, del piano e di squadra; si mandano con `attachmentIds` nei
// messaggi. Valgono la sessione, il pannello incorporato e i token personali con gli ambiti per metodo.

import express, { Router, type IRouter, type Response } from "express";
import {
  DeleteChatAttachmentParams,
  GetChatAttachmentParams,
  UploadChatAttachmentHeader,
  UploadChatAttachmentQueryParams,
  UploadChatAttachmentResponse,
} from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { ChatAttachmentError, deleteChatAttachment, getChatAttachment, saveChatAttachment } from "../lib/chat-attachments/service";
import { MAX_CHAT_ATTACHMENT_BYTES } from "../lib/chat-attachments/formats";
import { CHAT_ATTACHMENT_MESSAGES } from "../lib/chat-attachments/support";
import { rfc5987 } from "../lib/teams/attachments";
import { parseRequest } from "../middlewares/error-handler";
import { chatAttachmentUploadRateLimit } from "../middlewares/rate-limit";

function attachmentName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Errori di regola degli allegati con il loro stato; gli altri salgono al gestore comune. */
export async function guardedAttachments(res: Response, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ChatAttachmentError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

export function createChatAttachmentsRouter(): IRouter {
  const router: IRouter = Router();

  // Il limite del corpo dà 413 prima di leggere oltre 10 MB
  const raw = express.raw({ type: () => true, limit: MAX_CHAT_ATTACHMENT_BYTES });
  router.post("/chat-attachments", chatAttachmentUploadRateLimit, (req, res, next) => {
    raw(req, res, (err?: unknown) => {
      if (err && (err as { type?: unknown }).type === "entity.too.large") {
        res.status(413).json({ error: CHAT_ATTACHMENT_MESSAGES.tooLarge });
        return;
      }
      next(err);
    });
  }, async (req, res) => {
    const { conversationKind, conversationId } = parseRequest(UploadChatAttachmentQueryParams, req.query);
    const header = parseRequest(UploadChatAttachmentHeader, { "X-Attachment-Name": req.get("x-attachment-name") });
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    await guardedAttachments(res, async () => {
      const view = await saveChatAttachment(currentUserId(req), conversationKind, conversationId, {
        name: attachmentName(header["X-Attachment-Name"]),
        bytes,
      });
      res.status(201).json(UploadChatAttachmentResponse.parse(view));
    });
  });

  router.get("/chat-attachments/:id", async (req, res) => {
    const { id } = parseRequest(GetChatAttachmentParams, req.params);
    await guardedAttachments(res, async () => {
      const row = await getChatAttachment(currentUserId(req), id);
      // Scaricato, mai mostrato nella pagina con l'origine della console
      res.set({
        "Content-Type": row.contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${rfc5987(row.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      res.send(row.content);
    });
  });

  router.delete("/chat-attachments/:id", async (req, res) => {
    const { id } = parseRequest(DeleteChatAttachmentParams, req.params);
    await guardedAttachments(res, async () => {
      await deleteChatAttachment(currentUserId(req), id);
      res.status(204).end();
    });
  });

  return router;
}

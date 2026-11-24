// Invio di un messaggio con allegati nelle tre chat (issue #120): senza allegati vale `sendChatMessage` con il suo modo
// (normale, coda, subito); con allegati il turno parte subito e un turno in corso dà 409 (niente coda: il messaggio in
// coda non porta allegati).

import { sendChatMessage, type ChatSendMode, type ChatSendOutcome } from "../chat-turns/control";
import type { ChatKindSpec } from "../chat-turns/spec";
import type { PageContext } from "../characters/types";
import { ChatAttachmentError, attachmentsByMessage, type ChatAttachmentKind, type ChatAttachmentView } from "./service";
import { CHAT_ATTACHMENT_MESSAGES } from "./support";

export async function sendChatMessageWithAttachments<M>(
  spec: ChatKindSpec,
  conversationId: number,
  content: string,
  page: PageContext | null,
  mode: ChatSendMode,
  attachmentIds: number[],
  start: (attachmentIds: number[]) => Promise<M>,
): Promise<ChatSendOutcome<M>> {
  if (attachmentIds.length === 0) return sendChatMessage(spec, conversationId, content, page, mode, () => start([]));
  try {
    return { kind: "started", message: await start(attachmentIds) };
  } catch (err) {
    if (err instanceof Error && err.name === "TurnBusyError") throw new ChatAttachmentError(409, CHAT_ATTACHMENT_MESSAGES.busy);
    throw err;
  }
}

/** Funzione che aggiunge `attachments` ai messaggi che ne hanno (gli altri restano senza il campo). */
export async function attachmentDecorator(
  kind: ChatAttachmentKind,
  conversationId: number,
  messageIds: number[],
): Promise<<T extends { id: number }>(m: T) => T & { attachments?: ChatAttachmentView[] }> {
  const byMessage = await attachmentsByMessage(kind, conversationId, messageIds);
  return (m) => {
    const list = byMessage.get(m.id);
    return list ? { ...m, attachments: list } : m;
  };
}

// Allegati delle chat (issue #120): archiviazione (bytea, come gli allegati delle squadre), legame con il messaggio
// dell'utente all'invio, controlli dell'invio e lettura per il turno. Nei log solo id e conteggi, mai nomi né contenuti.

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  db,
  chatAttachmentsTable,
  characterConversationsTable,
  planConversationsTable,
  teamChatConversationsTable,
  type ChatAttachmentRow,
} from "@workspace/db";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  detectFormat,
  type AttachmentForModel,
} from "./formats";
import { CHAT_ATTACHMENT_MESSAGES, attachmentSupportError, loadModelCapabilities } from "./support";

export type ChatAttachmentKind = "character" | "plan_chat" | "team_chat";
export const CHAT_ATTACHMENT_KINDS: readonly ChatAttachmentKind[] = ["character", "plan_chat", "team_chat"];

/** Un allegato caricato e non mandato si cancella dopo un giorno (al caricamento successivo dello stesso utente). */
const UNSENT_TTL_MS = 24 * 3600_000;
const MAX_NAME = 200;

export class ChatAttachmentError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
    this.name = "ChatAttachmentError";
  }
}

export interface ChatAttachmentView {
  id: number;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  /** Messaggio dell'utente con cui è partito; null = caricato e non ancora mandato. */
  messageId: number | null;
  createdAt: Date;
}

const viewSelect = {
  id: chatAttachmentsTable.id,
  name: chatAttachmentsTable.name,
  contentType: chatAttachmentsTable.contentType,
  sizeBytes: chatAttachmentsTable.sizeBytes,
  sha256: chatAttachmentsTable.sha256,
  messageId: chatAttachmentsTable.messageId,
  createdAt: chatAttachmentsTable.createdAt,
};

/** Colonna della conversazione per il tipo di chat. */
export function conversationColumn(kind: ChatAttachmentKind): PgColumn {
  if (kind === "character") return chatAttachmentsTable.characterConversationId;
  if (kind === "plan_chat") return chatAttachmentsTable.planConversationId;
  return chatAttachmentsTable.teamChatConversationId;
}

const ofConversation = (kind: ChatAttachmentKind, conversationId: number): SQL =>
  and(eq(chatAttachmentsTable.conversationKind, kind), eq(conversationColumn(kind), conversationId))!;

/** Nome del file: 1..200 caratteri, senza separatori di percorso, `..` né caratteri di controllo. */
function validName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name.length >= 1 && name.length <= MAX_NAME && !/[/\\\u0000-\u001f\u007f]/.test(name) && !name.includes("..") && name.trim() !== "";
}

/**
 * La conversazione è dell'utente e si può scrivere: altrimenti 404 (anche se è di un altro) o 409 (personaggi
 * archiviati). Le altre regole della chat (squadra chiusa, argomento eliminato) le controlla l'invio del messaggio.
 */
export async function assertWritableConversation(userId: number, kind: ChatAttachmentKind, conversationId: number): Promise<void> {
  let owner: { userId: number; archivedAt?: Date | null } | undefined;
  if (kind === "character") {
    [owner] = await db
      .select({ userId: characterConversationsTable.userId, archivedAt: characterConversationsTable.archivedAt })
      .from(characterConversationsTable)
      .where(eq(characterConversationsTable.id, conversationId));
  } else if (kind === "plan_chat") {
    [owner] = await db.select({ userId: planConversationsTable.userId }).from(planConversationsTable).where(eq(planConversationsTable.id, conversationId));
  } else {
    [owner] = await db
      .select({ userId: teamChatConversationsTable.userId })
      .from(teamChatConversationsTable)
      .where(eq(teamChatConversationsTable.id, conversationId));
  }
  if (!owner || owner.userId !== userId) throw new ChatAttachmentError(404, CHAT_ATTACHMENT_MESSAGES.conversationNotFound);
  if (owner.archivedAt) throw new ChatAttachmentError(409, CHAT_ATTACHMENT_MESSAGES.readOnly);
}

/**
 * Salva un allegato non ancora mandato: formato dai primi byte (PNG, JPEG, WebP, PDF), al più 10 MB, 50 MB per
 * conversazione (mandati e no). Il limite si controlla con la riga della conversazione bloccata: due caricamenti insieme
 * non lo superano. Prima toglie gli allegati dell'utente caricati da oltre un giorno e mai mandati.
 */
export async function saveChatAttachment(
  userId: number,
  kind: ChatAttachmentKind,
  conversationId: number,
  input: { name: string; bytes: Buffer },
): Promise<ChatAttachmentView> {
  if (!validName(input.name) || input.bytes.length === 0) throw new ChatAttachmentError(400, CHAT_ATTACHMENT_MESSAGES.invalid);
  if (input.bytes.length > MAX_CHAT_ATTACHMENT_BYTES) throw new ChatAttachmentError(413, CHAT_ATTACHMENT_MESSAGES.tooLarge);
  const contentType = detectFormat(input.bytes);
  if (!contentType) throw new ChatAttachmentError(400, CHAT_ATTACHMENT_MESSAGES.format);
  await assertWritableConversation(userId, kind, conversationId);
  await purgeUnsent(userId);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  return db.transaction(async (tx) => {
    const conversations =
      kind === "character" ? characterConversationsTable : kind === "plan_chat" ? planConversationsTable : teamChatConversationsTable;
    const [locked] = await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, conversationId)).for("update");
    if (!locked) throw new ChatAttachmentError(404, CHAT_ATTACHMENT_MESSAGES.conversationNotFound);
    const [used] = await tx
      .select({ total: sql<string>`coalesce(sum(${chatAttachmentsTable.sizeBytes}), 0)` })
      .from(chatAttachmentsTable)
      .where(ofConversation(kind, conversationId));
    if (Number(used?.total ?? 0) + input.bytes.length > MAX_CONVERSATION_ATTACHMENT_BYTES) {
      throw new ChatAttachmentError(413, CHAT_ATTACHMENT_MESSAGES.quota);
    }
    const [row] = await tx
      .insert(chatAttachmentsTable)
      .values({
        userId,
        conversationKind: kind,
        characterConversationId: kind === "character" ? conversationId : null,
        planConversationId: kind === "plan_chat" ? conversationId : null,
        teamChatConversationId: kind === "team_chat" ? conversationId : null,
        name: input.name,
        contentType,
        sizeBytes: input.bytes.length,
        sha256,
        content: input.bytes,
      })
      .returning(viewSelect);
    return row!;
  });
}

/** Toglie gli allegati dell'utente caricati da oltre un giorno e mai mandati. */
export async function purgeUnsent(userId: number, now: Date = new Date()): Promise<number> {
  const removed = await db
    .delete(chatAttachmentsTable)
    .where(
      and(
        eq(chatAttachmentsTable.userId, userId),
        isNull(chatAttachmentsTable.messageId),
        lt(chatAttachmentsTable.createdAt, new Date(now.getTime() - UNSENT_TTL_MS)),
      ),
    )
    .returning({ id: chatAttachmentsTable.id });
  return removed.length;
}

/** Un allegato dell'utente, con il contenuto; altrimenti 404. */
export async function getChatAttachment(userId: number, id: number): Promise<ChatAttachmentRow> {
  const [row] = await db
    .select()
    .from(chatAttachmentsTable)
    .where(and(eq(chatAttachmentsTable.id, id), eq(chatAttachmentsTable.userId, userId)))
    .limit(1);
  if (!row) throw new ChatAttachmentError(404, CHAT_ATTACHMENT_MESSAGES.notFound);
  return row;
}

/** Elimina un allegato dell'utente non ancora mandato (uno mandato resta con il suo messaggio: 409). */
export async function deleteChatAttachment(userId: number, id: number): Promise<void> {
  const deleted = await db
    .delete(chatAttachmentsTable)
    .where(and(eq(chatAttachmentsTable.id, id), eq(chatAttachmentsTable.userId, userId), isNull(chatAttachmentsTable.messageId)))
    .returning({ id: chatAttachmentsTable.id });
  if (deleted.length > 0) return;
  await getChatAttachment(userId, id);
  throw new ChatAttachmentError(409, CHAT_ATTACHMENT_MESSAGES.alreadySent);
}

/**
 * Controlli dell'invio di un messaggio con allegati: al più 5, senza ripetizioni, tutti dell'utente, della conversazione
 * e non ancora mandati, e il modello della conversazione li deve poter leggere (`attachmentSupportError`). Lista vuota:
 * nulla da controllare.
 */
export async function checkAttachmentsForSend(
  userId: number,
  kind: ChatAttachmentKind,
  conversationId: number,
  ids: number[],
  aiModelId: number | null,
): Promise<void> {
  if (ids.length === 0) return;
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new ChatAttachmentError(400, CHAT_ATTACHMENT_MESSAGES.tooMany);
  if (new Set(ids).size !== ids.length) throw new ChatAttachmentError(400, CHAT_ATTACHMENT_MESSAGES.repeated);
  const rows = await db
    .select({ id: chatAttachmentsTable.id, contentType: chatAttachmentsTable.contentType })
    .from(chatAttachmentsTable)
    .where(
      and(
        inArray(chatAttachmentsTable.id, ids),
        eq(chatAttachmentsTable.userId, userId),
        ofConversation(kind, conversationId),
        isNull(chatAttachmentsTable.messageId),
      ),
    );
  if (rows.length !== ids.length) throw new ChatAttachmentError(409, CHAT_ATTACHMENT_MESSAGES.unavailable);
  if (aiModelId === null) throw new ChatAttachmentError(409, CHAT_ATTACHMENT_MESSAGES.noModel);
  const model = await loadModelCapabilities(aiModelId);
  if (!model) throw new ChatAttachmentError(409, CHAT_ATTACHMENT_MESSAGES.noModel);
  const error = attachmentSupportError(
    model,
    rows.map((r) => r.contentType),
  );
  if (error) throw new ChatAttachmentError(409, error);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lega gli allegati al messaggio dell'utente appena scritto, nella stessa transazione dell'inserimento: se uno non è più
 * libero (mandato da un'altra richiesta, eliminato) la transazione si annulla con 409.
 */
export async function bindChatAttachments(
  tx: Tx,
  kind: ChatAttachmentKind,
  conversationId: number,
  messageId: number,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return;
  const bound = await tx
    .update(chatAttachmentsTable)
    .set({ messageId })
    .where(and(inArray(chatAttachmentsTable.id, ids), ofConversation(kind, conversationId), isNull(chatAttachmentsTable.messageId)))
    .returning({ id: chatAttachmentsTable.id });
  if (bound.length !== ids.length) throw new ChatAttachmentError(409, CHAT_ATTACHMENT_MESSAGES.unavailable);
}

/** Allegati (senza contenuto) dei messaggi dati, per messaggio. */
export async function attachmentsByMessage(
  kind: ChatAttachmentKind,
  conversationId: number,
  messageIds: number[],
): Promise<Map<number, ChatAttachmentView[]>> {
  const byMessage = new Map<number, ChatAttachmentView[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .select(viewSelect)
    .from(chatAttachmentsTable)
    .where(and(ofConversation(kind, conversationId), inArray(chatAttachmentsTable.messageId, messageIds)))
    .orderBy(asc(chatAttachmentsTable.id));
  for (const r of rows) {
    const list = byMessage.get(r.messageId!) ?? [];
    list.push(r);
    byMessage.set(r.messageId!, list);
  }
  return byMessage;
}

/** Nomi degli allegati per messaggio di tutta la conversazione (note nella cronologia del modello). */
export async function attachmentNamesByMessage(kind: ChatAttachmentKind, conversationId: number): Promise<Map<number, string[]>> {
  const rows = await db
    .select({ messageId: chatAttachmentsTable.messageId, name: chatAttachmentsTable.name })
    .from(chatAttachmentsTable)
    .where(and(ofConversation(kind, conversationId), sql`${chatAttachmentsTable.messageId} is not null`))
    .orderBy(asc(chatAttachmentsTable.id));
  const names = new Map<number, string[]>();
  for (const r of rows) names.set(r.messageId!, [...(names.get(r.messageId!) ?? []), r.name]);
  return names;
}

/**
 * Allegati, con il contenuto, dell'ultimo messaggio dell'utente prima del messaggio dell'assistente del turno: sono
 * quelli che il modello riceve in questo turno (quelli dei messaggi precedenti restano una nota nella cronologia).
 */
export async function turnAttachments(
  kind: ChatAttachmentKind,
  conversationId: number,
  assistantMessageId: number,
  messagesTable: string,
): Promise<AttachmentForModel[]> {
  const last = await db.execute(sql`
    select id from ${sql.identifier(messagesTable)}
     where conversation_id = ${conversationId} and role = 'user' and queued_at is null and id < ${assistantMessageId}
     order by id desc
     limit 1`);
  const userMessageId = (last.rows[0] as { id?: number } | undefined)?.id;
  if (userMessageId === undefined) return [];
  return db
    .select({ name: chatAttachmentsTable.name, contentType: chatAttachmentsTable.contentType, content: chatAttachmentsTable.content })
    .from(chatAttachmentsTable)
    .where(and(ofConversation(kind, conversationId), eq(chatAttachmentsTable.messageId, Number(userMessageId))))
    .orderBy(asc(chatAttachmentsTable.id));
}

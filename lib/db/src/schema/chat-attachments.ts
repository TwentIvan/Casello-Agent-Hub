import { pgTable, serial, integer, text, timestamp, index, check, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { instructionConversationKindEnum } from "./character-instructions";
import { characterConversationsTable } from "./characters";
import { planConversationsTable } from "./plan-conversations";
import { teamChatConversationsTable } from "./team-chat";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// Allegati delle chat (issue #120): immagini e PDF caricati in una conversazione dei personaggi, del piano o di squadra,
// legati al messaggio dell'utente con cui partono (`message_id` null = caricato e non ancora mandato). Una sola delle
// tre colonne della conversazione è valorizzata, quella del `conversation_kind`: eliminando la conversazione gli
// allegati spariscono a cascata. Lo schema dei campi del file è quello di `team_attachments`.
export const chatAttachmentsTable = pgTable(
  "chat_attachments",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    conversationKind: instructionConversationKindEnum("conversation_kind").notNull(),
    characterConversationId: integer("character_conversation_id").references(() => characterConversationsTable.id, { onDelete: "cascade" }),
    planConversationId: integer("plan_conversation_id").references(() => planConversationsTable.id, { onDelete: "cascade" }),
    teamChatConversationId: integer("team_chat_conversation_id").references(() => teamChatConversationsTable.id, { onDelete: "cascade" }),
    // Messaggio dell'utente (nella tabella dei messaggi della chat): null finché non si manda
    messageId: integer("message_id"),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    content: bytea("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_attachments_character_idx").on(t.characterConversationId),
    index("chat_attachments_plan_idx").on(t.planConversationId),
    index("chat_attachments_team_chat_idx").on(t.teamChatConversationId),
    check(
      "chat_attachments_conversation_check",
      sql`(${t.conversationKind} = 'character' and ${t.characterConversationId} is not null and ${t.planConversationId} is null and ${t.teamChatConversationId} is null)
        or (${t.conversationKind} = 'plan_chat' and ${t.planConversationId} is not null and ${t.characterConversationId} is null and ${t.teamChatConversationId} is null)
        or (${t.conversationKind} = 'team_chat' and ${t.teamChatConversationId} is not null and ${t.characterConversationId} is null and ${t.planConversationId} is null)`,
    ),
  ],
);

export type ChatAttachmentRow = typeof chatAttachmentsTable.$inferSelect;

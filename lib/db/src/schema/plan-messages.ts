import { pgTable, serial, integer, text, timestamp, pgEnum, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { planConversationsTable } from "./plan-conversations";

export const planMessageRoleEnum = pgEnum("plan_message_role", ["user", "assistant"]);

// Messaggio di una conversazione sul piano
export const planMessagesTable = pgTable(
  "plan_messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => planConversationsTable.id, { onDelete: "cascade" }),
    role: planMessageRoleEnum("role").notNull(),
    // Markdown
    content: text("content").notNull(),
    // Messaggio del bot che riporta un errore
    error: boolean("error").notNull().default(false),
    tokens: integer("tokens").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Messaggio in attesa del turno in corso (uno al più per conversazione)
    queuedAt: timestamp("queued_at"),
  },
  (table) => [
    index("plan_messages_conversation_idx").on(table.conversationId, table.id),
    uniqueIndex("plan_messages_queued_uidx").on(table.conversationId).where(sql`${table.queuedAt} IS NOT NULL`),
  ],
);

export type PlanMessage = typeof planMessagesTable.$inferSelect;

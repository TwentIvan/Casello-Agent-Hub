import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { agentsTable } from "./agents";
import { runsTable } from "./runs";

// Conversazione dell'utente con il Responsabile di prodotto di Botcave (pannello, scheda «Responsabile").
// Le risposte non si copiano: ogni messaggio porta la sua run.
export const leadConversationsTable = pgTable(
  "lead_conversations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    agentId: integer("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    // Dal primo messaggio, max 80 caratteri
    title: text("title").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    archivedAt: timestamp("archived_at"),
  },
  (table) => [index("lead_conversations_user_updated_idx").on(table.userId, table.updatedAt)],
);

// Un messaggio dell'utente, con la pagina da cui è scritto e la run nata dal messaggio
export const leadMessagesTable = pgTable(
  "lead_messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => leadConversationsTable.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    pageContext: jsonb("page_context"),
    runId: integer("run_id").references(() => runsTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("lead_messages_conversation_idx").on(table.conversationId, table.id)],
);

export type LeadConversation = typeof leadConversationsTable.$inferSelect;
export type LeadMessage = typeof leadMessagesTable.$inferSelect;

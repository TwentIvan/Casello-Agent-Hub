import { pgTable, serial, integer, text, timestamp, pgEnum, numeric, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { teamInstancesTable } from "./team-instances";
import { usersTable } from "./users";
import { aiModelsTable } from "./ai-models";
import { planTurnStatusEnum } from "./plan-conversations";
import { planMessageRoleEnum } from "./plan-messages";
import { planProposalStatusEnum } from "./plan-proposals";

export const teamChatProposalKindEnum = pgEnum("team_chat_proposal_kind", ["role_identity", "role_instructions"]);

// Conversazione con Lucius sulla definizione di una squadra (stessa forma della chat del piano)
export const teamChatConversationsTable = pgTable(
  "team_chat_conversations",
  {
    id: serial("id").primaryKey(),
    teamInstanceId: integer("team_instance_id")
      .notNull()
      .references(() => teamInstancesTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    // Dal primo messaggio, max 80 caratteri
    title: text("title").notNull(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    // null = costo parziale (prezzo mancante)
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    turnStatus: planTurnStatusEnum("turn_status").notNull().default("idle"),
    // Ultimo riassunto nello storico di Lucius
    summarizedAt: timestamp("summarized_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("team_chat_conversations_team_user_idx").on(table.teamInstanceId, table.userId)],
);

export const teamChatMessagesTable = pgTable(
  "team_chat_messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => teamChatConversationsTable.id, { onDelete: "cascade" }),
    role: planMessageRoleEnum("role").notNull(),
    // Markdown
    content: text("content").notNull(),
    // Messaggio del bot che riporta un errore
    error: boolean("error").notNull().default(false),
    tokens: integer("tokens").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("team_chat_messages_conversation_idx").on(table.conversationId, table.id)],
);

// Proposta di Lucius su un ruolo, da accettare o rifiutare
export const teamChatProposalsTable = pgTable(
  "team_chat_proposals",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => teamChatConversationsTable.id, { onDelete: "cascade" }),
    messageId: integer("message_id")
      .notNull()
      .references(() => teamChatMessagesTable.id, { onDelete: "cascade" }),
    kind: teamChatProposalKindEnum("kind").notNull(),
    roleKey: text("role_key").notNull(),
    // role_identity: {text}; role_instructions: {markdown}
    payload: jsonb("payload").notNull(),
    rationale: text("rationale").notNull(),
    // SHA-256 del valore attuale al momento della proposta
    targetHash: text("target_hash"),
    status: planProposalStatusEnum("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("team_chat_proposals_conversation_idx").on(table.conversationId)],
);

export type TeamChatConversation = typeof teamChatConversationsTable.$inferSelect;
export type TeamChatMessage = typeof teamChatMessagesTable.$inferSelect;
export type TeamChatProposal = typeof teamChatProposalsTable.$inferSelect;

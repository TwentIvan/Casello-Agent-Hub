import { pgTable, serial, integer, text, timestamp, numeric, boolean, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { aiModelsTable } from "./ai-models";
import { characterEnum } from "./character-memory";
import { planTurnStatusEnum } from "./plan-conversations";
import { planMessageRoleEnum } from "./plan-messages";
import { planProposalStatusEnum } from "./plan-proposals";

// Conversazione di un personaggio (Alfred o Lucius) su un argomento: il filo generale di Alfred o un oggetto dell'area
export const characterConversationsTable = pgTable(
  "character_conversations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    character: characterEnum("character").notNull(),
    // alfred_thread | agent | skill | team_template | area_agents | area_skills | area_team_templates
    subjectType: text("subject_type").notNull(),
    // null per i fili generali
    subjectId: text("subject_id"),
    // Titolo dell'oggetto alla creazione, mostrato se l'oggetto sparisce
    subjectTitle: text("subject_title"),
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    // Dal primo messaggio, max 80 caratteri
    title: text("title").notNull(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    // null = costo parziale (prezzo mancante)
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    turnStatus: planTurnStatusEnum("turn_status").notNull().default("idle"),
    archivedAt: timestamp("archived_at"),
    summarizedAt: timestamp("summarized_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "character_conversations_subject_type_check",
      sql`${table.subjectType} IN ('alfred_thread', 'agent', 'skill', 'team_template', 'area_agents', 'area_skills', 'area_team_templates')`,
    ),
    index("character_conversations_subject_idx").on(table.userId, table.character, table.subjectType, table.subjectId),
    // Un solo filo generale aperto per utente
    uniqueIndex("character_conversations_alfred_open_uniq")
      .on(table.userId)
      .where(sql`${table.subjectType} = 'alfred_thread' AND ${table.archivedAt} IS NULL`),
  ],
);

export const characterMessagesTable = pgTable(
  "character_messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => characterConversationsTable.id, { onDelete: "cascade" }),
    role: planMessageRoleEnum("role").notNull(),
    // Markdown
    content: text("content").notNull(),
    // Messaggio del bot che riporta un errore
    error: boolean("error").notNull().default(false),
    tokens: integer("tokens").notNull().default(0),
    // Solo messaggi dell'utente: {page, id?}
    pageContext: jsonb("page_context"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("character_messages_conversation_idx").on(table.conversationId, table.id)],
);

// Proposta di un personaggio, da accettare o rifiutare
export const characterProposalsTable = pgTable(
  "character_proposals",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => characterConversationsTable.id, { onDelete: "cascade" }),
    messageId: integer("message_id")
      .notNull()
      .references(() => characterMessagesTable.id, { onDelete: "cascade" }),
    // agent_prompt | agent_tools | skill_content | template_roles | agent_create | skill_create | template_create | decision | handoff | agent_trigger_create
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    rationale: text("rationale").notNull(),
    // SHA-256 del valore attuale al momento della proposta
    targetHash: text("target_hash"),
    status: planProposalStatusEnum("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "character_proposals_kind_check",
      sql`${table.kind} IN ('agent_prompt', 'agent_tools', 'skill_content', 'template_roles', 'agent_create', 'skill_create', 'template_create', 'decision', 'handoff', 'agent_trigger_create')`,
    ),
    index("character_proposals_conversation_idx").on(table.conversationId),
  ],
);

export type CharacterConversation = typeof characterConversationsTable.$inferSelect;
export type CharacterMessage = typeof characterMessagesTable.$inferSelect;
export type CharacterProposal = typeof characterProposalsTable.$inferSelect;

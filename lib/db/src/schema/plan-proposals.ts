import { pgTable, serial, integer, text, timestamp, pgEnum, jsonb, index } from "drizzle-orm/pg-core";
import { planConversationsTable } from "./plan-conversations";
import { planMessagesTable } from "./plan-messages";
import { analysisChapterEnum, analysisItemsTable } from "./analysis-items";

export const planProposalKindEnum = pgEnum("plan_proposal_kind", ["add", "update", "discard"]);
export const planProposalStatusEnum = pgEnum("plan_proposal_status", ["pending", "accepted", "rejected", "stale"]);

// Proposta del bot sul piano, da accettare o rifiutare. Il capitolo è uno tra endpoint, completion, evolution
// (la restrizione è applicativa)
export const planProposalsTable = pgTable(
  "plan_proposals",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => planConversationsTable.id, { onDelete: "cascade" }),
    messageId: integer("message_id")
      .notNull()
      .references(() => planMessagesTable.id, { onDelete: "cascade" }),
    kind: planProposalKindEnum("kind").notNull(),
    chapter: analysisChapterEnum("chapter").notNull(),
    // add e update: validato con ITEM_SCHEMAS[chapter]; discard: null
    payload: jsonb("payload"),
    rationale: text("rationale").notNull(),
    // Obbligatorio per update e discard
    targetItemId: integer("target_item_id").references(() => analysisItemsTable.id, { onDelete: "set null" }),
    // SHA-256 di payload e stato della voce di destinazione al momento della proposta
    targetHash: text("target_hash"),
    status: planProposalStatusEnum("status").notNull().default("pending"),
    // Voce creata o modificata all'accettazione
    itemId: integer("item_id").references(() => analysisItemsTable.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("plan_proposals_conversation_idx").on(table.conversationId)],
);

export type PlanProposal = typeof planProposalsTable.$inferSelect;

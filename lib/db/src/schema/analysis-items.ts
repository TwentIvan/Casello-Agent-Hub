import { pgTable, serial, integer, text, timestamp, pgEnum, jsonb, unique, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { analysesTable } from "./analyses";
import { planConversationsTable } from "./plan-conversations";

export const analysisChapterEnum = pgEnum("analysis_chapter", [
  "tool",
  "agent",
  "skill",
  "endpoint",
  "completion",
  "evolution",
]);
export const itemDiffEnum = pgEnum("item_diff", ["new", "changed", "removed", "unchanged"]);
export const itemStatusEnum = pgEnum("item_status", ["pending", "approved", "discarded", "postponed"]);
export const itemOriginEnum = pgEnum("item_origin", ["architect", "chat"]);

// Elementi della proposta dell'architetto, da rivedere uno per uno
export const analysisItemsTable = pgTable(
  "analysis_items",
  {
    id: serial("id").primaryKey(),
    analysisId: integer("analysis_id")
      .notNull()
      .references(() => analysesTable.id, { onDelete: "cascade" }),
    chapter: analysisChapterEnum("chapter").notNull(),
    // Chiave stabile nell'analisi, es. `tool:rosa_squadra`, `completion:3`
    ref: text("ref").notNull(),
    position: integer("position").notNull(),
    payload: jsonb("payload").notNull(),
    diff: itemDiffEnum("diff").notNull(),
    evidence: jsonb("evidence").notNull().default([]),
    status: itemStatusEnum("status").notNull().default("pending"),
    reviewNote: text("review_note"),
    appliedAt: timestamp("applied_at"),
    // Chi ha creato la voce: l'architetto o la chat del piano (con la conversazione relativa)
    origin: itemOriginEnum("origin").notNull().default("architect"),
    conversationId: integer("conversation_id").references(() => planConversationsTable.id, { onDelete: "set null" }),
    // Issue GitHub creata da Casello per la voce; `issueState`: creating (prenotazione) | open | closed
    issueRepo: text("issue_repo"),
    issueNumber: integer("issue_number"),
    issueUrl: text("issue_url"),
    issueState: text("issue_state"),
    issueStateReason: text("issue_state_reason"),
    issueCreatedAt: timestamp("issue_created_at"),
    issueCheckedAt: timestamp("issue_checked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("analysis_items_analysis_id_ref_unique").on(table.analysisId, table.ref),
    index("analysis_items_issue_idx")
      .on(table.issueRepo, table.issueNumber)
      .where(sql`${table.issueNumber} IS NOT NULL`),
  ],
);

export type AnalysisItem = typeof analysisItemsTable.$inferSelect;

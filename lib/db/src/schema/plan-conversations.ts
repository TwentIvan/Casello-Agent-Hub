import { pgTable, serial, integer, text, timestamp, pgEnum, numeric, index } from "drizzle-orm/pg-core";
import { appsTable } from "./apps";
import { analysesTable } from "./analyses";
import { usersTable } from "./users";
import { aiModelsTable } from "./ai-models";

export const planTurnStatusEnum = pgEnum("plan_turn_status", ["idle", "running"]);

// Conversazione con il bot sul piano di un'app (analisi di riferimento)
export const planConversationsTable = pgTable(
  "plan_conversations",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    analysisId: integer("analysis_id")
      .notNull()
      .references(() => analysesTable.id, { onDelete: "cascade" }),
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("plan_conversations_app_user_idx").on(table.appId, table.userId)],
);

export type PlanConversation = typeof planConversationsTable.$inferSelect;

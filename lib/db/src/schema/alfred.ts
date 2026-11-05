import { pgTable, serial, integer, text, timestamp, numeric, pgEnum, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { aiModelsTable } from "./ai-models";

export const alfredSessionStatusEnum = pgEnum("alfred_session_status", ["active", "closed"]);
export const alfredDecisionEnum = pgEnum("alfred_decision", ["approve", "reject"]);

// Sessione di Alfred, il maggiordomo vocale: token e costo cumulativi
export const alfredSessionsTable = pgTable(
  "alfred_sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    status: alfredSessionStatusEnum("status").notNull().default("active"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at").notNull().defaultNow(),
    closedAt: timestamp("closed_at"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    // null = prezzo mancante (costo parziale)
    costUsd: numeric("cost_usd", { precision: 14, scale: 8 }),
  },
  (table) => [index("alfred_sessions_user_status_idx").on(table.userId, table.status)],
);

// Conferma a voce di una decisione sulla coda: si salva solo l'hash del codice, uso singolo
export const alfredConfirmationsTable = pgTable(
  "alfred_confirmations",
  {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  sessionId: integer("session_id")
    .notNull()
    .references(() => alfredSessionsTable.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  decision: alfredDecisionEnum("decision").notNull(),
  note: text("note"),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("alfred_confirmations_session_used_idx").on(table.sessionId, table.usedAt)],
);

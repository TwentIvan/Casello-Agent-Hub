import { pgTable, pgEnum, serial, integer, text, boolean, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appsTable } from "./apps";
import { agentsTable } from "./agents";
import { aiModelsTable } from "./ai-models";
import { usersTable } from "./users";

export const architectureStatusEnum = pgEnum("architecture_status", ["idle", "running", "error"]);

// Sintesi dell'architettura di un'App: una riga per App, aggiornata dallo scheduler
export const appArchitectureTable = pgTable("app_architecture", {
  appId: integer("app_id")
    .primaryKey()
    .references(() => appsTable.id, { onDelete: "cascade" }),
  // Ultimo SHA sintetizzato (null prima della prima sintesi) e branch base usato
  sha: text("sha"),
  branch: text("branch"),
  // Ultimo SHA letto da GitHub
  seenSha: text("seen_sha"),
  repoMap: text("repo_map"),
  summary: text("summary"),
  status: architectureStatusEnum("status").notNull().default("idle"),
  lastError: text("last_error"),
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at"),
  checkedAt: timestamp("checked_at"),
  generatedAt: timestamp("generated_at"),
  startedAt: timestamp("started_at"),
  // Rigenerazione richiesta che salta l'intervallo
  forceRequested: boolean("force_requested").notNull().default(false),
  // Ultima generazione
  aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
});

// Una riga per generazione che ha chiamato il modello (riuscita o no): versioni e costi
export const appArchitectureRunsTable = pgTable(
  "app_architecture_runs",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
    sha: text("sha").notNull(),
    // Null se la generazione è fallita o se il testo è stato svuotato (oltre le ultime 20 versioni)
    summary: text("summary"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  },
  (table) => [index("app_architecture_runs_app_created_idx").on(table.appId, sql`${table.createdAt} desc`)],
);

export type AppArchitecture = typeof appArchitectureTable.$inferSelect;
export type AppArchitectureRun = typeof appArchitectureRunsTable.$inferSelect;

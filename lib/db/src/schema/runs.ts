import { pgTable, serial, integer, text, timestamp, pgEnum, jsonb, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { agentsTable } from "./agents";
import { aiModelsTable } from "./ai-models";

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "awaiting_client",
  "cancelled",
]);

export const runsTable = pgTable(
  "runs",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    // Modello con cui è partita la run (chi paga): non segue i cambi di modello dell'agente
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    status: runStatusEnum("status").notNull().default("pending"),
    input: text("input"),
    output: text("output"),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    pendingAction: jsonb("pending_action"),
    loopState: jsonb("loop_state"),
    pausedAt: timestamp("paused_at"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    // Quanti dei token di prompt il provider ha letto dalla cache
    cachedTokens: integer("cached_tokens").notNull().default(0),
    // Costo in USD, null se un prezzo del modello manca
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    // Somme del mese per i tetti di spesa
    index("runs_ai_model_created_idx").on(table.aiModelId, table.createdAt),
    index("runs_agent_created_idx").on(table.agentId, table.createdAt),
  ],
);

export const insertRunSchema = createInsertSchema(runsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertRun = z.infer<typeof insertRunSchema>;
export type Run = typeof runsTable.$inferSelect;

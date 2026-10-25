import { pgTable, serial, integer, text, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { agentsTable } from "./agents";

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "awaiting_client",
  "cancelled",
]);

export const runsTable = pgTable("runs", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id")
    .notNull()
    .references(() => agentsTable.id, { onDelete: "cascade" }),
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
  createdAt: timestamp("created_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
});

export const insertRunSchema = createInsertSchema(runsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertRun = z.infer<typeof insertRunSchema>;
export type Run = typeof runsTable.$inferSelect;

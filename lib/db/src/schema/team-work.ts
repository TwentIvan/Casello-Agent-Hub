import { pgTable, serial, integer, text, timestamp, boolean, jsonb, pgEnum, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { teamInstancesTable } from "./team-instances";
import { aiModelsTable } from "./ai-models";

export const teamTaskStatusEnum = pgEnum("team_task_status", [
  "queued",
  "running",
  "waiting_node",
  "done",
  "blocked",
  "failed",
  "cancelled",
]);
export const teamTurnStatusEnum = pgEnum("team_turn_status", ["queued", "running", "done", "failed"]);
export const teamEventTypeEnum = pgEnum("team_event_type", [
  "piano_proposto",
  "compito_finito",
  "bloccato",
  "decisione_richiesta",
  "azione_manuale_richiesta",
  "lavoro_finito",
  "interrotto",
]);

// Motivo di un turno del capo (accumulati nel turno in coda)
export type TeamTurnReason =
  | { type: "request"; text: string }
  | { type: "task_finished"; taskId: number }
  | { type: "decision"; number: number; outcome: "approved" | "rejected"; note: string | null }
  | { type: "activation" }
  | { type: "restart" };

// Esecuzione di un compito del PLAN da parte di un ruolo
export const teamTasksTable = pgTable(
  "team_tasks",
  {
    id: serial("id").primaryKey(),
    instanceId: integer("instance_id")
      .notNull()
      .references(() => teamInstancesTable.id, { onDelete: "cascade" }),
    planTaskId: text("plan_task_id").notNull(),
    roleKey: text("role_key").notNull(),
    instructions: text("instructions").notNull(),
    status: teamTaskStatusEnum("status").notNull().default("queued"),
    outcome: text("outcome"),
    detail: text("detail"),
    error: text("error"),
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    // Costo in USD, null se un prezzo del modello manca
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [index("team_tasks_instance_status_idx").on(table.instanceId, table.status)],
);

// Passi di un compito: stessa forma di `run_steps`
export const teamTaskStepsTable = pgTable(
  "team_task_steps",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => teamTasksTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: text("type").notNull(),
    toolName: text("tool_name"),
    args: jsonb("args"),
    ok: boolean("ok"),
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("team_task_steps_task_id_position_idx").on(table.taskId, table.position)],
);

// Turno del capo: al più uno `queued` e uno `running` per istanza (indici unici parziali)
export const teamTurnsTable = pgTable(
  "team_turns",
  {
    id: serial("id").primaryKey(),
    instanceId: integer("instance_id")
      .notNull()
      .references(() => teamInstancesTable.id, { onDelete: "cascade" }),
    reasons: jsonb("reasons").$type<TeamTurnReason[]>().notNull().default([]),
    status: teamTurnStatusEnum("status").notNull().default("queued"),
    error: text("error"),
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("team_turns_instance_status_idx").on(table.instanceId, table.status),
    uniqueIndex("team_turns_one_queued_unique").on(table.instanceId).where(sql`${table.status} = 'queued'`),
    uniqueIndex("team_turns_one_running_unique").on(table.instanceId).where(sql`${table.status} = 'running'`),
  ],
);

// Passi di un turno del capo: stessa forma di `run_steps`
export const teamTurnStepsTable = pgTable(
  "team_turn_steps",
  {
    id: serial("id").primaryKey(),
    turnId: integer("turn_id")
      .notNull()
      .references(() => teamTurnsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: text("type").notNull(),
    toolName: text("tool_name"),
    args: jsonb("args"),
    ok: boolean("ok"),
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("team_turn_steps_turn_id_position_idx").on(table.turnId, table.position)],
);

// Eventi della squadra (bollettino per l'utente)
export const teamEventsTable = pgTable(
  "team_events",
  {
    id: serial("id").primaryKey(),
    instanceId: integer("instance_id")
      .notNull()
      .references(() => teamInstancesTable.id, { onDelete: "cascade" }),
    type: teamEventTypeEnum("type").notNull(),
    taskId: integer("task_id").references(() => teamTasksTable.id, { onDelete: "set null" }),
    bulletin: text("bulletin").notNull(),
    detail: text("detail"),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("team_events_instance_created_idx").on(table.instanceId, table.createdAt)],
);

export type TeamTaskRow = typeof teamTasksTable.$inferSelect;
export type TeamTaskStepRow = typeof teamTaskStepsTable.$inferSelect;
export type TeamTurnRow = typeof teamTurnsTable.$inferSelect;
export type TeamTurnStepRow = typeof teamTurnStepsTable.$inferSelect;
export type TeamEventRow = typeof teamEventsTable.$inferSelect;

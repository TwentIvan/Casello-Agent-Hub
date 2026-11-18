import { pgTable, pgEnum, serial, integer, text, timestamp, numeric, jsonb, unique, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appsTable } from "./apps";
import { aiModelsTable } from "./ai-models";
import { teamTemplatesTable } from "./team-templates";
import { teamInstancesTable } from "./team-instances";
import { usersTable } from "./users";
import { analysesTable } from "./analyses";
import { teamWorksTable } from "./team-works";
import { pendingActionsTable } from "./pending-actions";

export const evolutionCycleStatusEnum = pgEnum("evolution_cycle_status", ["active", "paused"]);
export const evolutionFrequencyEnum = pgEnum("evolution_frequency", ["daily", "every_3_days", "weekly", "monthly"]);
export const evolutionMergeModeEnum = pgEnum("evolution_merge_mode", ["staging", "direct"]);
export const evolutionRoundStatusEnum = pgEnum("evolution_round_status", [
  "analyzing",
  "approving",
  "implementing",
  "awaiting_release",
  "done",
  "blocked",
  "rejected",
  "stopped",
  "failed",
]);

// Ciclo di evoluzione automatica: una riga per App
export const evolutionCyclesTable = pgTable(
  "evolution_cycles",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    status: evolutionCycleStatusEnum("status").notNull().default("active"),
    // Messaggio fisso, null se il ciclo è attivo
    pausedReason: text("paused_reason"),
    frequency: evolutionFrequencyEnum("frequency").notNull().default("weekly"),
    itemsPerRound: integer("items_per_round").notNull().default(3),
    analysisAiModelId: integer("analysis_ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    teamTemplateId: integer("team_template_id").references(() => teamTemplatesTable.id, { onDelete: "set null" }),
    teamInstanceId: integer("team_instance_id").references(() => teamInstancesTable.id, { onDelete: "set null" }),
    mergeMode: evolutionMergeModeEnum("merge_mode").notNull().default("direct"),
    // Null con merge_mode = direct
    stagingBranch: text("staging_branch"),
    stagingUrl: text("staging_url"),
    monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 12, scale: 2 }).notNull(),
    // Consenso: chi attiva, quando, con quale versione del testo e impronta delle impostazioni
    activatedBy: integer("activated_by").references(() => usersTable.id, { onDelete: "set null" }),
    consentAt: timestamp("consent_at"),
    consentVersion: text("consent_version"),
    consentHash: text("consent_hash"),
    nextRoundAt: timestamp("next_round_at"),
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("evolution_cycles_app_id_unique").on(table.appId),
    check("evolution_cycles_items_per_round_check", sql`${table.itemsPerRound} BETWEEN 1 AND 10`),
    check("evolution_cycles_budget_check", sql`${table.monthlyBudgetUsd} > 0`),
  ],
);

// Un giro del ciclo: analisi, approvazione, implementazione
export const evolutionRoundsTable = pgTable(
  "evolution_rounds",
  {
    id: serial("id").primaryKey(),
    cycleId: integer("cycle_id")
      .notNull()
      .references(() => evolutionCyclesTable.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    status: evolutionRoundStatusEnum("status").notNull(),
    analysisId: integer("analysis_id").references(() => analysesTable.id, { onDelete: "set null" }),
    // Voci approvate dal ciclo
    itemIds: jsonb("item_ids").$type<number[]>().notNull().default([]),
    outcome: text("outcome"),
    // Nota dell'utente sull'ultimo rifiuto di «Porta in produzione» del giro: entra nell'analisi del giro dopo
    rejectionNote: text("rejection_note"),
    // 3c: squadra del ciclo, lavoro del giro, voce «Porta in produzione» del lavoro, istante (orologio del DB) del messaggio al capo
    teamInstanceId: integer("team_instance_id").references(() => teamInstancesTable.id, { onDelete: "set null" }),
    workId: integer("work_id").references(() => teamWorksTable.id, { onDelete: "set null" }),
    pendingActionId: integer("pending_action_id").references(() => pendingActionsTable.id, { onDelete: "set null" }),
    implementationStartedAt: timestamp("implementation_started_at"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    unique("evolution_rounds_cycle_id_number_unique").on(table.cycleId, table.number),
    // Al più un giro aperto per ciclo
    uniqueIndex("evolution_rounds_one_open")
      .on(table.cycleId)
      .where(sql`${table.status} in ('analyzing', 'approving', 'implementing', 'awaiting_release')`),
  ],
);

export type EvolutionCycle = typeof evolutionCyclesTable.$inferSelect;
export type EvolutionRound = typeof evolutionRoundsTable.$inferSelect;

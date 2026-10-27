import { pgTable, serial, integer, text, timestamp, pgEnum, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { localMachinesTable } from "./local-machines";
import { analysesTable } from "./analyses";
import { runsTable } from "./runs";
import { aiModelsTable } from "./ai-models";

export const localJobKindEnum = pgEnum("local_job_kind", ["analysis", "run"]);

export const localJobStatusEnum = pgEnum("local_job_status", [
  "queued",
  "waiting_choice",
  "postponed",
  "claimed",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

// runner: preso dal runner della macchina; chat: preso da una sessione di chat con il token personale
export const localClaimedByEnum = pgEnum("local_claimed_by", ["runner", "chat"]);

// console: avviato dall'utente dalla console; app: avviato da una app (run di un agente)
export const localJobOriginEnum = pgEnum("local_job_origin", ["console", "app"]);

/**
 * Elemento in lavorazione: il prompt consegnato al runner e se riprendere la sessione di Claude Code del lavoro
 * (`claude_session_id`, letta alla consegna: il done del compito precedente la scrive prima).
 */
export type LocalJobCurrentItem = { id: string; prompt: string; resume: boolean };

// Coda dei lavori da eseguire su una macchina locale; il token del lavoro è salvato solo come hash
export const localJobsTable = pgTable(
  "local_jobs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    machineId: integer("machine_id")
      .notNull()
      .references(() => localMachinesTable.id, { onDelete: "cascade" }),
    kind: localJobKindEnum("kind").notNull(),
    analysisId: integer("analysis_id").references(() => analysesTable.id, { onDelete: "cascade" }),
    runId: integer("run_id").references(() => runsTable.id, { onDelete: "cascade" }),
    status: localJobStatusEnum("status").notNull().default("queued"),
    origin: localJobOriginEnum("origin").notNull(),
    // Modello di riserva se l'agente locale non è disponibile
    fallbackAiModelId: integer("fallback_ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    // Sessione di Claude Code, per riprendere con --resume dopo una pausa
    claudeSessionId: text("claude_session_id"),
    claimedBy: localClaimedByEnum("claimed_by"),
    currentItem: jsonb("current_item").$type<LocalJobCurrentItem | null>(),
    jobTokenHash: text("job_token_hash"),
    jobTokenExpiresAt: timestamp("job_token_expires_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("local_jobs_machine_status_idx").on(table.machineId, table.status),
    uniqueIndex("local_jobs_job_token_hash_unique").on(table.jobTokenHash).where(sql`${table.jobTokenHash} is not null`),
  ],
);

export type LocalJob = typeof localJobsTable.$inferSelect;

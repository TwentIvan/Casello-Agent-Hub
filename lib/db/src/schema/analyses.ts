import { pgTable, serial, integer, text, timestamp, pgEnum, jsonb, uniqueIndex, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appsTable } from "./apps";
import { aiModelsTable } from "./ai-models";

export const analysisStatusEnum = pgEnum("analysis_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
]);

export type AnalysisSources = { code: "github" | "zip" | "none"; openapi: boolean; description: boolean };
export type AnalysisLogEntry = { at: string; phase: string; message: string };

// Analisi dell'architetto su una app: le sorgenti restano in memoria, qui solo mappa, log ed esiti
export const analysesTable = pgTable(
  "analyses",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "restrict" }),
    status: analysisStatusEnum("status").notNull().default("queued"),
    sources: jsonb("sources").$type<AnalysisSources>().notNull(),
    maxTokens: integer("max_tokens").notNull(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    // Costo in USD, null se un prezzo del modello manca
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    // Fase corrente
    phase: text("phase"),
    // Al massimo 500 voci
    log: jsonb("log").$type<AnalysisLogEntry[]>().notNull().default([]),
    architectureMap: jsonb("architecture_map"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    // Un'analisi alla volta per app
    uniqueIndex("analyses_one_active_per_app")
      .on(table.appId)
      .where(sql`${table.status} in ('queued', 'running')`),
  ],
);

export type Analysis = typeof analysesTable.$inferSelect;

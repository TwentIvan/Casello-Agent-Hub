import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { analysesTable } from "./analyses";

// Esito di una fase consegnato dall'agente locale (già validato con Zod). Una sola consegna per fase
export const analysisPhaseResultsTable = pgTable(
  "analysis_phase_results",
  {
    id: serial("id").primaryKey(),
    analysisId: integer("analysis_id")
      .notNull()
      .references(() => analysesTable.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(),
    result: jsonb("result").notNull(),
    submittedAt: timestamp("submitted_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("analysis_phase_results_unique").on(table.analysisId, table.phase)],
);

export type AnalysisPhaseResult = typeof analysisPhaseResultsTable.$inferSelect;

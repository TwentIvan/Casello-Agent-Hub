import { pgTable, serial, integer, text, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { runsTable } from "./runs";

// Passi di una run: chiamate al modello (`model`) e ai tool (`tool`), in ordine di `position`
export const runStepsTable = pgTable(
  "run_steps",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
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
  (table) => [index("run_steps_run_id_position_idx").on(table.runId, table.position)],
);

export type RunStep = typeof runStepsTable.$inferSelect;

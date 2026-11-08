import { pgTable, serial, integer, text, timestamp, pgEnum, unique, index } from "drizzle-orm/pg-core";
import { pendingActionsTable } from "./pending-actions";
import { appToolsTable } from "./app-tools";

export const pendingActionStepStatusEnum = pgEnum("pending_action_step_status", [
  "pending",
  "excluded",
  "skipped",
  "done",
  "failed",
  "not_run",
]);

// Passi di una proposta multipla (`pending_actions.kind = proposal`): `key` = p1, p2… nell'ordine di `position`
export const pendingActionStepsTable = pgTable(
  "pending_action_steps",
  {
    id: serial("id").primaryKey(),
    pendingActionId: integer("pending_action_id")
      .notNull()
      .references(() => pendingActionsTable.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    position: integer("position").notNull(),
    toolId: integer("tool_id")
      .notNull()
      .references(() => appToolsTable.id, { onDelete: "restrict" }),
    summary: text("summary").notNull(),
    status: pendingActionStepStatusEnum("status").notNull().default("pending"),
    result: text("result"),
    errorMessage: text("error_message"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    unique("pending_action_steps_action_key_unique").on(table.pendingActionId, table.key),
    index("pending_action_steps_tool_id_idx").on(table.toolId),
  ],
);

export type PendingActionStepRow = typeof pendingActionStepsTable.$inferSelect;

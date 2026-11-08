import { pgTable, serial, integer, text, timestamp, pgEnum, jsonb, unique, index, check } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { appsTable } from "./apps";
import { appToolsTable } from "./app-tools";
import { agentsTable } from "./agents";
import { runsTable } from "./runs";
import { teamInstancesTable } from "./team-instances";
import { sql } from "drizzle-orm";

export const pendingActionStatusEnum = pgEnum("pending_action_status", [
  "pending",
  "executing",
  "done",
  "failed",
  "rejected",
]);

// `action` = azione L2 di un tool; `plan` / `plan_change` = proposta di PLAN di una squadra (senza tool né app); `proposal` = proposta con più passi di un agente (app obbligatoria, senza tool)
export const pendingActionKindEnum = pgEnum("pending_action_kind", ["action", "plan", "plan_change", "proposal"]);

// Coda delle azioni L2 in attesa di conferma: argomenti fissati (cifrati), esito e decisione
export const pendingActionsTable = pgTable(
  "pending_actions",
  {
    id: serial("id").primaryKey(),
    // Chi ha avviato la run; `number` è il progressivo per utente
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    kind: pendingActionKindEnum("kind").notNull().default("action"),
    // Null solo per `plan` / `plan_change` (vincolo CHECK)
    appId: integer("app_id")
      .references(() => appsTable.id, { onDelete: "cascade" }),
    toolId: integer("tool_id")
      .references(() => appToolsTable.id, { onDelete: "restrict" }),
    teamInstanceId: integer("team_instance_id").references(() => teamInstancesTable.id, { onDelete: "set null" }),
    planVersion: integer("plan_version"),
    runId: integer("run_id").references(() => runsTable.id, { onDelete: "set null" }),
    agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
    // Argomenti cifrati con CASELLO_SECRET_KEY e gli stessi con i parametri x-sensitive oscurati
    argsEnc: text("args_enc").notNull(),
    argsPublic: jsonb("args_public").notNull(),
    recipient: text("recipient").notNull(),
    summary: text("summary").notNull(),
    status: pendingActionStatusEnum("status").notNull().default("pending"),
    result: text("result"),
    errorMessage: text("error_message"),
    decidedBy: integer("decided_by").references(() => usersTable.id, { onDelete: "set null" }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    decidedAt: timestamp("decided_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    unique("pending_actions_user_number_unique").on(table.userId, table.number),
    index("pending_actions_user_status_idx").on(table.userId, table.status),
    check("pending_actions_action_needs_tool_check", sql`${table.kind} <> 'action' OR (${table.toolId} IS NOT NULL AND ${table.appId} IS NOT NULL)`),
  ],
);

export type PendingActionRow = typeof pendingActionsTable.$inferSelect;

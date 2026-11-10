import { pgTable, serial, integer, text, timestamp, boolean, pgEnum, index, unique } from "drizzle-orm/pg-core";
import { teamInstancesTable } from "./team-instances";

export const codePrStateEnum = pgEnum("code_pr_state", ["open", "merged", "closed"]);
export const codeCiStateEnum = pgEnum("code_ci_state", ["pending", "success", "failure", "none"]);

// Codice scritto da un compito del PLAN: branch, PR e stato della CI (una riga per compito)
export const teamCodeTasksTable = pgTable(
  "team_code_tasks",
  {
    id: serial("id").primaryKey(),
    instanceId: integer("instance_id")
      .notNull()
      .references(() => teamInstancesTable.id, { onDelete: "cascade" }),
    planTaskId: text("plan_task_id").notNull(),
    repo: text("repo").notNull(),
    branch: text("branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    headSha: text("head_sha"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    // Null finché non c'è una PR
    prState: codePrStateEnum("pr_state"),
    ciState: codeCiStateEnum("ci_state"),
    ciSummary: text("ci_summary"),
    ciCheckedAt: timestamp("ci_checked_at"),
    ciNotifiedSha: text("ci_notified_sha"),
    ciPendingNotified: boolean("ci_pending_notified").notNull().default(false),
    lastCommitAt: timestamp("last_commit_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("team_code_tasks_instance_plan_task_unique").on(table.instanceId, table.planTaskId),
    index("team_code_tasks_watch_idx").on(table.prState, table.ciCheckedAt),
  ],
);

export type TeamCodeTaskRow = typeof teamCodeTasksTable.$inferSelect;

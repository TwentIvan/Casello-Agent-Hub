import { pgTable, serial, integer, text, timestamp, pgEnum, jsonb, unique } from "drizzle-orm/pg-core";
import { teamInstancesTable } from "./team-instances";

export const teamPlanStatusEnum = pgEnum("team_plan_status", ["draft", "proposed", "approved"]);

// Compito del PLAN e azione manuale: forme salvate nei jsonb (l'API le verifica con Zod a ogni scrittura)
export type PlanTaskData = {
  id: string;
  title: string;
  roleKey: string;
  instructions: string;
  status: "planned" | "running" | "waiting_node" | "done" | "blocked" | "failed";
  outcome: string | null;
  updatedAt: string;
};
export type PlanManualActionData = { id: string; text: string; done: boolean; doneAt: string | null };
export type PlanData = {
  objective: string;
  constraints: string[];
  openPoints: string[];
  tasks: PlanTaskData[];
  manualActions: PlanManualActionData[];
};

// PLAN corrente di una squadra (una riga per istanza); ogni versione resta in `team_plan_versions`
export const teamPlansTable = pgTable(
  "team_plans",
  {
    id: serial("id").primaryKey(),
    instanceId: integer("instance_id")
      .notNull()
      .references(() => teamInstancesTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    status: teamPlanStatusEnum("status").notNull().default("draft"),
    objective: text("objective").notNull().default(""),
    constraints: jsonb("constraints").$type<string[]>().notNull().default([]),
    openPoints: jsonb("open_points").$type<string[]>().notNull().default([]),
    tasks: jsonb("tasks").$type<PlanTaskData[]>().notNull().default([]),
    manualActions: jsonb("manual_actions").$type<PlanManualActionData[]>().notNull().default([]),
    // Ultima versione approvata dall'utente
    approvedVersion: integer("approved_version"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [unique("team_plans_instance_unique").on(table.instanceId)],
);

export const teamPlanVersionsTable = pgTable(
  "team_plan_versions",
  {
    id: serial("id").primaryKey(),
    instanceId: integer("instance_id")
      .notNull()
      .references(() => teamInstancesTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    plan: jsonb("plan").$type<PlanData>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [unique("team_plan_versions_instance_version_unique").on(table.instanceId, table.version)],
);

export type TeamPlanRow = typeof teamPlansTable.$inferSelect;
export type TeamPlanVersionRow = typeof teamPlanVersionsTable.$inferSelect;

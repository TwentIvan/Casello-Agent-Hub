import { pgTable, pgEnum, serial, integer, text, varchar, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { aiModelsTable } from "./ai-models";
import { appsTable } from "./apps";
import { analysesTable } from "./analyses";
import { pendingActionsTable } from "./pending-actions";

export const appBootstrapStatusEnum = pgEnum("app_bootstrap_status", ["pending", "running", "done", "failed", "rejected"]);

export type BootstrapStep = {
  key: "verify" | "personalize" | "register" | "analyze";
  status: "pending" | "done" | "failed";
  message: string | null;
  at: string | null;
};

// Nascita di un'App da zero da un repository modello: richiesta, passi e checklist dell'utente
export const appBootstrapsTable = pgTable(
  "app_bootstraps",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    domain: varchar("domain", { length: 253 }).notNull(),
    repo: text("repo").notNull(),
    installationId: integer("installation_id").notNull(),
    brief: text("brief").notNull(),
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    status: appBootstrapStatusEnum("status").notNull().default("pending"),
    steps: jsonb("steps").$type<BootstrapStep[]>().notNull().default([]),
    initCommitSha: text("init_commit_sha"),
    appId: integer("app_id").references(() => appsTable.id, { onDelete: "set null" }),
    analysisId: integer("analysis_id").references(() => analysesTable.id, { onDelete: "set null" }),
    pendingActionId: integer("pending_action_id").references(() => pendingActionsTable.id, { onDelete: "set null" }),
    checklist: jsonb("checklist").$type<Record<string, { doneAt: string }>>().notNull().default({}),
    healthOkAt: timestamp("health_ok_at"),
    healthCheckedAt: timestamp("health_checked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("app_bootstraps_slug_open_uidx")
      .on(table.slug)
      .where(sql`${table.status} in ('pending', 'running') or (${table.status} = 'done' and ${table.appId} is not null)`),
    uniqueIndex("app_bootstraps_repo_open_uidx")
      .on(table.repo)
      .where(sql`${table.status} in ('pending', 'running') or (${table.status} = 'done' and ${table.appId} is not null)`),
    index("app_bootstraps_app_id_idx").on(table.appId),
  ],
);

export type AppBootstrap = typeof appBootstrapsTable.$inferSelect;

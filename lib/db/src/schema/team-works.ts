import { pgTable, pgEnum, serial, integer, text, timestamp, jsonb, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { teamInstancesTable } from "./team-instances";
import { pendingActionsTable } from "./pending-actions";

export const teamWorkStatusEnum = pgEnum("team_work_status", ["open", "awaiting_release", "releasing", "released", "abandoned"]);

// Lavoro su branch unico di una squadra con codice: i compiti con codice partono dal suo branch e le loro PR si uniscono lì;
// a fine lavoro la versione di prova e la voce «Porta in produzione» (spec 2026-11-16-botcave-evoluzione-automatica §15)
export const teamWorksTable = pgTable(
  "team_works",
  {
    id: serial("id").primaryKey(),
    instanceId: integer("instance_id")
      .notNull()
      .references(() => teamInstancesTable.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    status: teamWorkStatusEnum("status").notNull().default("open"),
    repo: text("repo").notNull(),
    branch: text("branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha"),
    // Nomi dei file `-post` uniti nel lavoro: li vede l'utente in «Porta in produzione»
    postScripts: jsonb("post_scripts").$type<string[]>().notNull().default([]),
    pendingActionId: integer("pending_action_id").references(() => pendingActionsTable.id, { onDelete: "set null" }),
    releasePrNumber: integer("release_pr_number"),
    releasePrUrl: text("release_pr_url"),
    releaseCiSince: timestamp("release_ci_since"),
    rejectionNote: text("rejection_note"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("team_works_instance_number_unique").on(table.instanceId, table.number),
    // Al più un lavoro non chiuso per squadra
    uniqueIndex("team_works_one_open")
      .on(table.instanceId)
      .where(sql`${table.status} in ('open', 'awaiting_release', 'releasing')`),
  ],
);

export type TeamWork = typeof teamWorksTable.$inferSelect;

import { pgTable, serial, integer, text, timestamp, pgEnum, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const catalogTriggerEnum = pgEnum("catalog_trigger", ["scheduled", "manual"]);
export const catalogRunStatusEnum = pgEnum("catalog_run_status", ["running", "completed", "partial", "failed"]);

// Esecuzioni dell'aggiornamento del catalogo. user_id è null per quelle pianificate
export const catalogRunsTable = pgTable(
  "catalog_runs",
  {
    id: serial("id").primaryKey(),
    trigger: catalogTriggerEnum("trigger").notNull(),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    status: catalogRunStatusEnum("status").notNull(),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
    summary: jsonb("summary"),
    // Testo fisso, mai il messaggio grezzo di una fonte
    error: text("error"),
  },
  (table) => [
    // Al massimo un aggiornamento in corso alla volta
    uniqueIndex("catalog_runs_one_running").on(table.status).where(sql`${table.status} = 'running'`),
  ],
);

export type CatalogRun = typeof catalogRunsTable.$inferSelect;

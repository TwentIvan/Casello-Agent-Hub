import { pgTable, integer, boolean, varchar, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

// Politica della flotta degli agenti (issue #117): una sola riga (id = 1) con le regole di coordinamento comuni a
// tutte le run: pausa centrale (nessuna run nuova parte, gli inneschi non scattano) e limiti di concorrenza dello
// scheduler (artifacts/api-server/src/lib/run-queue.ts). Senza riga valgono i valori predefiniti del codice
// (artifacts/api-server/src/lib/fleet/policy.ts). Agenti e App sono condivisi tra gli utenti ammessi: la politica anche.
export const fleetPolicyTable = pgTable(
  "fleet_policy",
  {
    id: integer("id").primaryKey().default(1),
    paused: boolean("paused").notNull().default(false),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedBy: integer("paused_by").references(() => usersTable.id, { onDelete: "set null" }),
    // Motivo scritto dall'utente (≤ 300 caratteri su una riga)
    pauseReason: varchar("pause_reason", { length: 300 }),
    maxRunningRuns: integer("max_running_runs").notNull().default(6),
    maxRunningPerAgent: integer("max_running_per_agent").notNull().default(2),
    updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("fleet_policy_singleton_check", sql`${t.id} = 1`),
    check("fleet_policy_limits_check", sql`${t.maxRunningRuns} between 1 and 20 and ${t.maxRunningPerAgent} between 1 and 10`),
  ],
);

export type FleetPolicyRow = typeof fleetPolicyTable.$inferSelect;

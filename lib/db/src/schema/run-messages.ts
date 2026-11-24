import { pgTable, serial, integer, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { runsTable } from "./runs";
import { usersTable } from "./users";

// Istruzioni mandate dall'utente a una run in corso (issue #119): il ciclo dell'agente le legge tra un passo e l'altro
// e le inserisce come messaggio dell'utente prima della chiamata successiva al modello. `pending` = in attesa del ciclo,
// `delivered` = consegnata al modello, `dropped` = la run è finita prima di consegnarla.
export const runMessageStatusEnum = pgEnum("run_message_status", ["pending", "delivered", "dropped"]);

export const runMessagesTable = pgTable(
  "run_messages",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
    // Autore: null se l'utente è stato eliminato
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    content: text("content").notNull(),
    status: runMessageStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [index("run_messages_run_id_status_idx").on(t.runId, t.status)],
);

export type RunMessageRow = typeof runMessagesTable.$inferSelect;

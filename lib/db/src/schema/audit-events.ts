import { pgTable, serial, integer, varchar, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Registro delle azioni (issue #115): chi ha fatto cosa e quando sulle operazioni sensibili (approvazioni, conferme,
// token, segreti, account AI, nodi, accessi). Una riga per evento riuscito; mai segreti, token, argomenti o testi
// dell'utente: solo azione, oggetto (tipo e id) e pochi campi di dettaglio scelti dal codice
// (artifacts/api-server/src/lib/audit/). Eliminando l'utente si eliminano anche i suoi eventi.
export const auditEventsTable = pgTable(
  "audit_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Codice dell'azione, es. `api_token.create`, `pending_action.approve` (elenco in lib/audit/actions.ts)
    action: varchar("action", { length: 80 }).notNull(),
    objectType: varchar("object_type", { length: 40 }),
    objectId: varchar("object_id", { length: 100 }),
    // Campi di dettaglio non sensibili (es. esito, ambiti di un token)
    detail: jsonb("detail").$type<Record<string, string | number | boolean | null | string[]>>(),
    // Canale: session, token, embed, mcp, alfred, chat
    via: varchar("via", { length: 20 }).notNull(),
    tokenId: integer("token_id"),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_user_created_idx").on(t.userId, t.createdAt),
    index("audit_events_created_idx").on(t.createdAt),
  ],
);

export type AuditEvent = typeof auditEventsTable.$inferSelect;

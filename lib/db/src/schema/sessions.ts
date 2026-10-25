import { pgTable, varchar, json, timestamp, index } from "drizzle-orm/pg-core";

// Sessioni di login (store di connect-pg-simple): nomi e tipi delle colonne sono quelli attesi dalla libreria.
export const sessionsTable = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6 }).notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

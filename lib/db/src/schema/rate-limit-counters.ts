import { pgTable, integer, varchar, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Contatori persistenti del rate limit a finestra fissa (vedi artifacts/api-server/src/middlewares/rate-limit.ts, persistentWindowCounter):
// una riga per utente, contatore (`bucket`) e inizio della finestra. Sopravvivono ai riavvii e ai deploy.
export const rateLimitCountersTable = pgTable(
  "rate_limit_counters",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    bucket: varchar("bucket", { length: 100 }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.bucket, t.windowStart] }),
    index("rate_limit_counters_window_start_idx").on(t.windowStart),
  ],
);

import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

// Utenti di Casello. L'email è salvata sempre in minuscolo (il codice la normalizza prima di scrivere)
export const usersTable = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    picture: text("picture"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at"),
  },
  (table) => [unique("users_email_unique").on(table.email)],
);

export type User = typeof usersTable.$inferSelect;

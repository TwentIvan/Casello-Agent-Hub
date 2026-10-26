import { pgTable, serial, integer, text, timestamp, pgEnum, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const identityProviderEnum = pgEnum("identity_provider", ["google", "github"]);

// Account esterni collegati a un utente: un solo account per provider, e ogni account a un solo utente
export const userIdentitiesTable = pgTable(
  "user_identities",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    provider: identityProviderEnum("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    email: text("email"),
    username: text("username"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("user_identities_provider_user_unique").on(table.provider, table.providerUserId),
    unique("user_identities_user_provider_unique").on(table.userId, table.provider),
  ],
);

export type UserIdentity = typeof userIdentitiesTable.$inferSelect;

import { pgTable, serial, integer, bigint, jsonb, text, timestamp, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Installazioni dell'App GitHub di Casello collegate a un utente (nessun token salvato).
// account_type (User | Organization) e repository_selection (all | selected) sono i valori di GitHub
export const githubInstallationsTable = pgTable(
  "github_installations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    repositorySelection: text("repository_selection").notNull(),
    // Repo dell'installazione che l'utente vede davvero su GitHub (proprietario/nome in minuscolo),
    // letti con il suo token alla callback; null = non ancora verificati (si ricollega GitHub)
    userRepos: jsonb("user_repos").$type<string[]>(),
    userReposCheckedAt: timestamp("user_repos_checked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [unique("github_installations_user_installation_unique").on(table.userId, table.installationId)],
);

export type GithubInstallation = typeof githubInstallationsTable.$inferSelect;

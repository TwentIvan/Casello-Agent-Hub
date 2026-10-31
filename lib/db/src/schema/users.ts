import { pgTable, serial, integer, text, timestamp, unique, numeric, type AnyPgColumn } from "drizzle-orm/pg-core";
import { aiModelsTable } from "./ai-models";

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
    // Tetto di spesa mensile in USD sui propri account AI; null = nessun limite
    monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 12, scale: 2 }),
    // Modello predefinito per gli agenti che Casello crea; null = nessuno (anche se il modello è eliminato)
    defaultAiModelId: integer("default_ai_model_id").references((): AnyPgColumn => aiModelsTable.id, { onDelete: "set null" }),
  },
  (table) => [unique("users_email_unique").on(table.email)],
);

export type User = typeof usersTable.$inferSelect;

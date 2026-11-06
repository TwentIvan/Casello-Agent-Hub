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
    // Modello del centralino (squadre); null = nessuno
    centralinoAiModelId: integer("centralino_ai_model_id").references((): AnyPgColumn => aiModelsTable.id, { onDelete: "set null" }),
    // Modello e voce di Alfred (maggiordomo vocale); null = nessuno
    alfredAiModelId: integer("alfred_ai_model_id").references((): AnyPgColumn => aiModelsTable.id, { onDelete: "set null" }),
    alfredVoice: text("alfred_voice"),
    // Modello di Alfred nelle chat delle aree e modello di Lucius; null = nessuno
    alfredChatAiModelId: integer("alfred_chat_ai_model_id").references((): AnyPgColumn => aiModelsTable.id, { onDelete: "set null" }),
    luciusAiModelId: integer("lucius_ai_model_id").references((): AnyPgColumn => aiModelsTable.id, { onDelete: "set null" }),
    // Tetti di spesa mensili per personaggio in USD; null = nessun limite
    alfredMonthlyBudgetUsd: numeric("alfred_monthly_budget_usd", { precision: 12, scale: 2 }),
    luciusMonthlyBudgetUsd: numeric("lucius_monthly_budget_usd", { precision: 12, scale: 2 }),
  },
  (table) => [unique("users_email_unique").on(table.email)],
);

export type User = typeof usersTable.$inferSelect;

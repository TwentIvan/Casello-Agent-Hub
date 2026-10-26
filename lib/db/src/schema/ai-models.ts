import { pgTable, serial, integer, text, boolean, timestamp, numeric, unique } from "drizzle-orm/pg-core";
import { aiAccountsTable } from "./ai-accounts";

// Modelli di un account. I prezzi sono USD per milione di token: numeric, letti da Drizzle come stringa
export const aiModelsTable = pgTable(
  "ai_models",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => aiAccountsTable.id, { onDelete: "cascade" }),
    // Id del modello presso il provider, es. deepseek-chat
    modelId: text("model_id").notNull(),
    displayName: text("display_name").notNull(),
    contextTokens: integer("context_tokens"),
    priceInputPerMtok: numeric("price_input_per_mtok", { precision: 12, scale: 6 }),
    priceOutputPerMtok: numeric("price_output_per_mtok", { precision: 12, scale: 6 }),
    // provider | manual | seed
    priceSource: text("price_source"),
    hidden: boolean("hidden").notNull().default(false),
    // Arrivato da /models del provider o aggiunto a mano
    discovered: boolean("discovered").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [unique("ai_models_account_model_unique").on(table.accountId, table.modelId)],
);

export type AiModel = typeof aiModelsTable.$inferSelect;

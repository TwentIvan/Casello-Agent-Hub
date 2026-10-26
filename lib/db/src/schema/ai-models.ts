import { pgTable, serial, integer, text, boolean, timestamp, numeric, unique, pgEnum } from "drizzle-orm/pg-core";
import { aiAccountsTable } from "./ai-accounts";
import { modelCatalogTable } from "./model-catalog";
import { modelOffersTable } from "./model-offers";

export const aiModelAvailabilityEnum = pgEnum("ai_model_availability", ["available", "unavailable", "unknown"]);

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
    // provider | manual | seed | catalog
    priceSource: text("price_source"),
    hidden: boolean("hidden").notNull().default(false),
    // Arrivato da /models del provider o aggiunto a mano
    discovered: boolean("discovered").notNull().default(false),
    availability: aiModelAvailabilityEnum("availability").notNull().default("unknown"),
    supportsTools: boolean("supports_tools"),
    // Riga del catalogo da cui arrivano prezzi e metadati; si perde se la riga del catalogo sparisce
    catalogId: integer("catalog_id").references(() => modelCatalogTable.id, { onDelete: "set null" }),
    // Offerta del catalogo universale da cui arrivano prezzi e metadati; si perde se l'offerta sparisce
    offerId: integer("offer_id").references(() => modelOffersTable.id, { onDelete: "set null" }),
    lastProbeAt: timestamp("last_probe_at"),
    lastProbeOk: boolean("last_probe_ok"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [unique("ai_models_account_model_unique").on(table.accountId, table.modelId)],
);

export type AiModel = typeof aiModelsTable.$inferSelect;

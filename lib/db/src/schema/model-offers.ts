import { pgTable, serial, integer, text, boolean, timestamp, numeric, unique, pgEnum, jsonb, index } from "drizzle-orm/pg-core";
import { modelsTable } from "./models";
import { providersTable } from "./providers";

export const modelCatalogStatusEnum = pgEnum("model_catalog_status", ["available", "deprecated", "retired"]);

// Un modello presso un provider (prezzi, contesto, stato), aggiornato dalle fonti pubbliche.
// I prezzi sono USD per milione di token: numeric, letti da Drizzle come stringa
export const modelOffersTable = pgTable(
  "model_offers",
  {
    id: serial("id").primaryKey(),
    modelId: integer("model_id")
      .notNull()
      .references(() => modelsTable.id, { onDelete: "cascade" }),
    provider: text("provider")
      .notNull()
      .references(() => providersTable.slug, { onUpdate: "cascade" }),
    // Id del modello presso il provider, normalizzato (senza `models/`, minuscolo)
    providerModelId: text("provider_model_id").notNull(),
    priceInputPerMtok: numeric("price_input_per_mtok", { precision: 12, scale: 6 }),
    priceOutputPerMtok: numeric("price_output_per_mtok", { precision: 12, scale: 6 }),
    // Prezzo dei token di prompt letti dalla cache; arriva ad ai_models con enrichFromCatalog
    priceCachedInputPerMtok: numeric("price_cached_input_per_mtok", { precision: 12, scale: 6 }),
    contextTokens: integer("context_tokens"),
    supportsTools: boolean("supports_tools"),
    status: modelCatalogStatusEnum("status").notNull().default("available"),
    deprecationDate: timestamp("deprecation_date"),
    // Fonte di ciascun campo, per audit e per l'aggiornamento parziale
    sources: jsonb("sources").notNull().default({}),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("model_offers_provider_model_unique").on(table.provider, table.providerModelId),
    index("model_offers_model_id_idx").on(table.modelId),
  ],
);

export type ModelOfferRow = typeof modelOffersTable.$inferSelect;

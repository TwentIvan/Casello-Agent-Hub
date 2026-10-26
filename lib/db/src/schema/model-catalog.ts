import { pgTable, serial, integer, text, boolean, timestamp, numeric, unique, jsonb } from "drizzle-orm/pg-core";
import { providersTable } from "./providers";
import { modelCatalogStatusEnum } from "./model-offers";

// Catalogo dei modelli per provider della prima versione: non più scritto (sostituito da models e model_offers),
// letto ancora da GET /catalog/models finché non viene eliminato.
// I prezzi sono USD per milione di token: numeric, letti da Drizzle come stringa
export const modelCatalogTable = pgTable(
  "model_catalog",
  {
    id: serial("id").primaryKey(),
    provider: text("provider")
      .notNull()
      .references(() => providersTable.slug, { onUpdate: "cascade" }),
    // Id del modello presso il provider
    modelId: text("model_id").notNull(),
    family: text("family").notNull(),
    version: text("version").notNull(),
    releasedAt: timestamp("released_at"),
    priceInputPerMtok: numeric("price_input_per_mtok", { precision: 12, scale: 6 }),
    priceOutputPerMtok: numeric("price_output_per_mtok", { precision: 12, scale: 6 }),
    contextTokens: integer("context_tokens"),
    supportsTools: boolean("supports_tools"),
    status: modelCatalogStatusEnum("status").notNull().default("available"),
    deprecationDate: timestamp("deprecation_date"),
    // Dato letto da ciascuna fonte, per audit
    sources: jsonb("sources").notNull().default({}),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [unique("model_catalog_provider_model_unique").on(table.provider, table.modelId)],
);

export type CatalogModelRow = typeof modelCatalogTable.$inferSelect;

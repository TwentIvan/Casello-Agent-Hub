import { pgTable, serial, integer, text, boolean, timestamp, numeric, unique, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { providersTable } from "./providers";

export const modelCatalogStatusEnum = pgEnum("model_catalog_status", ["available", "deprecated", "retired"]);

// Catalogo dei modelli per provider, aggiornato dalle fonti pubbliche (non dipende dagli account degli utenti).
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

import { pgTable, text, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";

// Come si parla con il provider: openai_compatible e local_agent (agente locale) hanno un esecutore
export const providerProtocolEnum = pgEnum("provider_protocol", [
  "openai_compatible",
  "anthropic",
  "bedrock",
  "vertex",
  "azure",
  "local_agent",
  "unknown",
]);

// managed: esecutore disponibile; coming: protocollo noto senza esecutore; unmanaged: sconosciuto al registro
export const providerStatusEnum = pgEnum("provider_status", ["managed", "coming", "unmanaged"]);

// registry: dal registro nel codice; discovered: comparso nelle fonti del catalogo
export const providerOriginEnum = pgEnum("provider_origin", ["registry", "discovered"]);

/** Nomi del provider nelle fonti: `litellm_provider` di LiteLLM e autore OpenRouter dei suoi modelli. */
export type ProviderSourceKeys = { litellm: string[]; openrouterAuthor: string | null };

// Provider AI: allineati all'avvio dal registro nel codice (api-server, lib/catalog/provider-registry-data.ts) o scoperti
// dall'aggiornamento del catalogo
export const providersTable = pgTable("providers", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  protocol: providerProtocolEnum("protocol").notNull(),
  // Null se lo inserisce l'utente o dipende dall'ambiente (regione, risorsa, variabili)
  defaultBaseUrl: text("default_base_url"),
  sourceKeys: jsonb("source_keys").$type<ProviderSourceKeys>().notNull(),
  status: providerStatusEnum("status").notNull(),
  origin: providerOriginEnum("origin").notNull(),
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ProviderRow = typeof providersTable.$inferSelect;

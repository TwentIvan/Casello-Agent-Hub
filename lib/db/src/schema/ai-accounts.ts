import { pgTable, serial, integer, text, boolean, timestamp, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const aiProviderEnum = pgEnum("ai_provider", [
  "deepseek",
  "openrouter",
  "huggingface",
  "mistral",
  "groq",
  "together",
  "custom",
  "system_gateway",
]);

export const aiAccountStatusEnum = pgEnum("ai_account_status", ["unverified", "ok", "error"]);

// Account presso un provider AI. user_id è null solo per l'account di sistema (gateway di Casello).
// La chiave è salvata cifrata (api_key_enc), null per system_gateway
export const aiAccountsTable = pgTable(
  "ai_accounts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: aiProviderEnum("provider").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeyEnc: text("api_key_enc"),
    // Solo per il provider custom
    allowPrivateNetwork: boolean("allow_private_network").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    status: aiAccountStatusEnum("status").notNull().default("unverified"),
    // Testo fisso, mai il messaggio grezzo del provider
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Al massimo un account predefinito per utente
    uniqueIndex("ai_accounts_one_default_per_user").on(table.userId).where(sql`${table.isDefault}`),
  ],
);

export type AiAccount = typeof aiAccountsTable.$inferSelect;

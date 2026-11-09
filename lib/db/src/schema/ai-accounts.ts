import { pgTable, serial, integer, text, boolean, timestamp, numeric, pgEnum, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { providersTable } from "./providers";
import { nodesTable } from "./nodes";
import { aiModelsTable } from "./ai-models";

export const aiAccountStatusEnum = pgEnum("ai_account_status", ["unverified", "ok", "error"]);

// Account presso un provider AI. user_id è null solo per il vecchio account del gateway (dismesso),
// finché la migrazione 2026-10-pulizia-gateway-post.sql non lo elimina: il codice lo ignora.
// La chiave è salvata cifrata (api_key_enc); null se il provider non la richiede
export const aiAccountsTable = pgTable(
  "ai_accounts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Slug del provider (testo con FK: i provider sono dati, non un enum)
    provider: text("provider")
      .notNull()
      .references(() => providersTable.slug, { onUpdate: "cascade" }),
    baseUrl: text("base_url").notNull(),
    apiKeyEnc: text("api_key_enc"),
    // Solo per il provider custom
    allowPrivateNetwork: boolean("allow_private_network").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    status: aiAccountStatusEnum("status").notNull().default("unverified"),
    // Testo fisso, mai il messaggio grezzo del provider
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at"),
    // Tetto di spesa mensile in USD; null = nessun limite
    monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 12, scale: 2 }),
    // Solo per il provider claude_code_node: il nodo che esegue i turni (un account per nodo)
    nodeId: integer("node_id").references(() => nodesTable.id, { onDelete: "set null" }),
    // Modello (di un account non nodo dello stesso utente) a cui vanno i turni se il nodo non risponde
    fallbackAiModelId: integer("fallback_ai_model_id").references((): AnyPgColumn => aiModelsTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Al massimo un account predefinito per utente
    uniqueIndex("ai_accounts_one_default_per_user").on(table.userId).where(sql`${table.isDefault}`),
    uniqueIndex("ai_accounts_one_per_node").on(table.nodeId).where(sql`${table.nodeId} is not null`),
  ],
);

export type AiAccount = typeof aiAccountsTable.$inferSelect;

import { pgTable, serial, integer, text, jsonb, timestamp, numeric, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { analysesTable } from "./analyses";
import { aiModelsTable } from "./ai-models";

// Ricerche di best practice di Lucius (Gemini con ricerca Google): cache per utente e registro dei costi
export const bestPracticeSearchesTable = pgTable(
  "best_practice_searches",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Valorizzato per le ricerche dell'analisi: il costo conta tramite l'analisi, non due volte
    analysisId: integer("analysis_id").references(() => analysesTable.id, { onDelete: "set null" }),
    // SHA-256 della domanda normalizzata in minuscolo
    queryHash: text("query_hash").notNull(),
    query: text("query").notNull(),
    answer: text("answer").notNull(),
    sources: jsonb("sources").$type<{ uri: string; title: string }[]>().notNull().default([]),
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    searchQueries: integer("search_queries").notNull().default(0),
    // null = prezzo dei token mancante
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    // Id della riga riusata (null se chiamata vera)
    cachedFrom: integer("cached_from").references((): AnyPgColumn => bestPracticeSearchesTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("best_practice_searches_lookup_idx").on(table.userId, table.queryHash, table.createdAt)],
);

export type BestPracticeSearch = typeof bestPracticeSearchesTable.$inferSelect;

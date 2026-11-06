import { pgTable, serial, integer, text, timestamp, pgEnum, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { aiModelsTable } from "./ai-models";

export const characterEnum = pgEnum("character", ["alfred", "lucius"]);
export const characterHistoryKindEnum = pgEnum("character_history_kind", [
  "alfred_session",
  "plan_conversation",
  "team_chat",
]);

// Appunti di un personaggio sull'utente: fatti e preferenze stabili (max 300 caratteri, 50 per personaggio)
export const characterNotesTable = pgTable(
  "character_notes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    character: characterEnum("character").notNull(),
    content: text("content").notNull(),
    ref: text("ref"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("character_notes_user_character_idx").on(table.userId, table.character)],
);

// Storico: un riassunto per conversazione, mai i messaggi interi
export const characterHistoryTable = pgTable(
  "character_history",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    character: characterEnum("character").notNull(),
    kind: characterHistoryKindEnum("kind").notNull(),
    refId: integer("ref_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    // Modello che ha scritto il riassunto e suo consumo (conta nella spesa dell'utente)
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    tokensUsed: integer("tokens_used").notNull().default(0),
    // null = costo parziale (prezzo mancante)
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Eliminata dall'utente (o potata): titolo e riassunto svuotati, il costo resta nella spesa
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("character_history_user_character_idx").on(table.userId, table.character),
    uniqueIndex("character_history_ref_uniq").on(table.userId, table.character, table.kind, table.refId),
  ],
);

export type CharacterNote = typeof characterNotesTable.$inferSelect;
export type CharacterHistoryEntry = typeof characterHistoryTable.$inferSelect;

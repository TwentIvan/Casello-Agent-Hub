import { pgTable, serial, text, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";

// Tipo del modello (`mode` di LiteLLM; OpenRouter è sempre chat): stessi valori di MODEL_MODES in api-server
export const modelModeEnum = pgEnum("model_mode", [
  "chat",
  "embedding",
  "image_generation",
  "image_edit",
  "audio_transcription",
  "audio_speech",
  "video_generation",
  "rerank",
  "moderation",
  "ocr",
  "search",
  "realtime",
  "responses",
  "completion",
  "other",
]);

// Modelli del catalogo universale, indipendenti dal provider: la chiave canonica abbina le offerte dei
// vari provider (Bedrock, Vertex, diretto...). Aggiornati dalle fonti pubbliche
export const modelsTable = pgTable("models", {
  id: serial("id").primaryKey(),
  canonicalKey: text("canonical_key").notNull().unique(),
  author: text("author").notNull(),
  family: text("family").notNull(),
  version: text("version").notNull(),
  mode: modelModeEnum("mode").notNull().default("chat"),
  // Null: non noto dalle fonti
  supportsTools: boolean("supports_tools"),
  supportsVision: boolean("supports_vision"),
  supportsReasoning: boolean("supports_reasoning"),
  releasedAt: timestamp("released_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ModelRow = typeof modelsTable.$inferSelect;

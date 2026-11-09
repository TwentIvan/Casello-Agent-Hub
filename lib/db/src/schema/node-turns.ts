import { pgTable, serial, integer, text, timestamp, jsonb, numeric, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { nodesTable } from "./nodes";
import { aiModelsTable } from "./ai-models";

export const nodeTurnStatusEnum = pgEnum("node_turn_status", ["queued", "running", "done", "failed", "cancelled", "expired"]);
export const nodeTurnConsumerEnum = pgEnum("node_turn_consumer", ["character", "plan_chat", "team_chat", "run"]);

// Turno di un modello delegato al nodo locale (Claude Code sul Mac): traccia tecnica, il risultato vero sta nel messaggio
// della conversazione o nella run. `package` si svuota alla chiusura; le righe chiuse da oltre 30 giorni si cancellano.
export const nodeTurnsTable = pgTable(
  "node_turns",
  {
    id: serial("id").primaryKey(),
    nodeId: integer("node_id").references(() => nodesTable.id, { onDelete: "set null" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    consumer: nodeTurnConsumerEnum("consumer").notNull(),
    // Id della conversazione o della run
    refId: integer("ref_id").notNull(),
    // Messaggio dell'assistente (chat)
    messageId: integer("message_id"),
    status: nodeTurnStatusEnum("status").notNull().default("queued"),
    package: jsonb("package").$type<Record<string, unknown>>(),
    // SHA-256 del token `cat_…` del turno
    turnTokenHash: text("turn_token_hash").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    content: text("content"),
    errorCode: text("error_code"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    cachedTokens: integer("cached_tokens"),
    // Riferito dal nodo; null = non noto
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    sessionId: text("session_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    claimedAt: timestamp("claimed_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("node_turns_node_status_idx").on(table.nodeId, table.status, table.createdAt),
    uniqueIndex("node_turns_token_hash_unique").on(table.turnTokenHash),
  ],
);

export type NodeTurn = typeof nodeTurnsTable.$inferSelect;

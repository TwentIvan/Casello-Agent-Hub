import { pgTable, pgEnum, serial, integer, text, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { teamInstancesTable } from "./team-instances";
import { teamTasksTable } from "./team-work";
import { aiModelsTable } from "./ai-models";

export const teamRoleMessageKindEnum = pgEnum("team_role_message_kind", ["consult", "note"]);
export const teamRoleMessageStatusEnum = pgEnum("team_role_message_status", ["pending", "answered", "failed", "delivered"]);

// Comunicazione diretta tra due ruoli collegati di una squadra: consultazione (domanda e risposta subito, con token e
// costo del ruolo consultato) o messaggio (nota consegnata al prossimo compito del destinatario)
export const teamRoleMessagesTable = pgTable(
  "team_role_messages",
  {
    id: serial("id").primaryKey(),
    instanceId: integer("instance_id")
      .notNull()
      .references(() => teamInstancesTable.id, { onDelete: "cascade" }),
    fromTaskId: integer("from_task_id").references(() => teamTasksTable.id, { onDelete: "set null" }),
    fromRole: text("from_role").notNull(),
    toRole: text("to_role").notNull(),
    kind: teamRoleMessageKindEnum("kind").notNull(),
    status: teamRoleMessageStatusEnum("status").notNull().default("pending"),
    text: text("text").notNull(),
    answer: text("answer"),
    error: text("error"),
    deliveredTaskId: integer("delivered_task_id").references(() => teamTasksTable.id, { onDelete: "set null" }),
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("team_role_messages_instance_idx").on(table.instanceId, table.createdAt),
    index("team_role_messages_pending_notes_idx")
      .on(table.instanceId, table.toRole)
      .where(sql`${table.kind} = 'note' AND ${table.status} = 'pending'`),
  ],
);

export type TeamRoleMessageRow = typeof teamRoleMessagesTable.$inferSelect;

import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  pgEnum,
  boolean,
  jsonb,
  index,
  unique,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentsTable } from "./agents";
import { appToolsTable } from "./app-tools";
import { usersTable } from "./users";

export const triggerKindEnum = pgEnum("trigger_kind", ["poll", "webhook"]);
export const triggerStatusEnum = pgEnum("trigger_status", ["active", "paused", "error"]);

// Innesco: sorveglia un tool (poll) o riceve un webhook e avvia le run di un agente
export const agentTriggersTable = pgTable(
  "agent_triggers",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    kind: triggerKindEnum("kind").notNull(),
    name: text("name").notNull(),
    status: triggerStatusEnum("status").notNull().default("paused"),
    // Testo dell'utente (fidato, ≤ 2 000) che apre l'input della run
    instructions: text("instructions"),
    createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    // Solo poll: tool da chiamare a ogni giro e argomenti fissi
    toolId: integer("tool_id").references(() => appToolsTable.id, { onDelete: "restrict" }),
    args: jsonb("args").notNull().default({}),
    // Percorsi dei campi nella risposta (1..5 segmenti separati da punto)
    itemsPath: text("items_path"),
    idField: text("id_field"),
    versionField: text("version_field"),
    cursorParam: text("cursor_param"),
    cursorField: text("cursor_field"),
    cursorValue: text("cursor_value"),
    // {field, equals}
    filter: jsonb("filter"),
    intervalSeconds: integer("interval_seconds").default(300),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    baselineDone: boolean("baseline_done").notNull().default(false),
    // Solo webhook: header con l'id dell'evento, hash del segreto dell'URL, segreto di firma cifrato
    dedupHeader: text("dedup_header"),
    secretHash: text("secret_hash"),
    signingSecretEnc: text("signing_secret_enc"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastError: text("last_error"),
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    runsCreated: integer("runs_created").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("agent_triggers_agent_name_key").on(table.agentId, table.name),
    check(
      "agent_triggers_poll_check",
      sql`${table.kind} <> 'poll' OR (${table.toolId} IS NOT NULL AND ${table.intervalSeconds} IS NOT NULL AND ${table.nextPollAt} IS NOT NULL)`,
    ),
    check("agent_triggers_webhook_check", sql`${table.kind} <> 'webhook' OR ${table.secretHash} IS NOT NULL`),
    check("agent_triggers_cursor_check", sql`${table.cursorParam} IS NULL OR ${table.cursorField} IS NOT NULL`),
    index("agent_triggers_due_idx").on(table.status, table.nextPollAt),
    index("agent_triggers_agent_idx").on(table.agentId),
  ],
);

// Chiavi degli elementi già visti: l'INSERT ... ON CONFLICT DO NOTHING è la deduplicazione
export const triggerSeenItemsTable = pgTable(
  "trigger_seen_items",
  {
    triggerId: integer("trigger_id")
      .notNull()
      .references(() => agentTriggersTable.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.triggerId, table.itemKey] }),
    index("trigger_seen_items_seen_at_idx").on(table.seenAt),
  ],
);

export type AgentTrigger = typeof agentTriggersTable.$inferSelect;
export type TriggerSeenItem = typeof triggerSeenItemsTable.$inferSelect;

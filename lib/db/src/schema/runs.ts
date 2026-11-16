import { pgTable, serial, integer, text, timestamp, pgEnum, numeric, index, boolean, jsonb, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { agentsTable } from "./agents";
import { aiModelsTable } from "./ai-models";
import { agentTriggersTable } from "./agent-triggers";

/** Azione `ui` di una run in attesa del client (`runs.client_action`). */
export interface ClientActionRow {
  id: string;
  tool: string;
  action: string;
  args: Record<string, unknown>;
  requestedAt: string;
  /** Esito mandato dal client: presente solo dopo la risposta */
  result?: { ok: boolean; content: string };
}

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  // Run in attesa dell'esito di un'azione `ui` eseguita dal client (client_action)
  "awaiting_client",
  "cancelled",
]);

export const runsTable = pgTable(
  "runs",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    // Modello con cui è partita la run (chi paga): non segue i cambi di modello dell'agente
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    status: runStatusEnum("status").notNull().default("pending"),
    input: text("input"),
    output: text("output"),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    // La pausa per conferma non esiste più: la conferma passa dalla coda delle azioni (pending_actions)
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    // Quanti dei token di prompt il provider ha letto dalla cache
    cachedTokens: integer("cached_tokens").notNull().default(0),
    // Costo in USD, null se un prezzo del modello manca
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    // Run madre (segnalazione al Responsabile di prodotto): null se la run non nasce da un'altra
    parentRunId: integer("parent_run_id").references((): AnyPgColumn => runsTable.id, { onDelete: "set null" }),
    // La run è partita con un token utente tenuto solo in memoria (si perde al riavvio)
    hasUserToken: boolean("has_user_token").notNull().default(false),
    // Innesco che ha avviato la run (sorveglianza o webhook): null se avviata a mano o da un'altra run
    triggerId: integer("trigger_id").references(() => agentTriggersTable.id, { onDelete: "set null" }),
    // Il client che ha avviato la run esegue i tool `ui` dell'app (lib/client-actions.ts)
    clientTools: boolean("client_tools").notNull().default(false),
    // Azione `ui` in attesa del client, con l'esito quando arriva; null fuori dall'attesa
    clientAction: jsonb("client_action").$type<ClientActionRow>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    // Somme del mese per i tetti di spesa
    index("runs_ai_model_created_idx").on(table.aiModelId, table.createdAt),
    index("runs_agent_created_idx").on(table.agentId, table.createdAt),
    // Scheduler: conteggio delle run per agente e stato
    index("runs_agent_status_idx").on(table.agentId, table.status),
    index("runs_parent_run_id_idx").on(table.parentRunId),
    index("runs_trigger_id_idx").on(table.triggerId),
  ],
);

export const insertRunSchema = createInsertSchema(runsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertRun = z.infer<typeof insertRunSchema>;
export type Run = typeof runsTable.$inferSelect;

import { pgTable, serial, integer, text, boolean, timestamp, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { appsTable } from "./apps";
import { toolIdentityEnum } from "./app-tools";
import { aiModelsTable } from "./ai-models";

export const agentStatusEnum = pgEnum("agent_status", ["active", "inactive", "draft"]);

// Cosa fare quando l'agente locale non è collegato a una run avviata da un'app
export const localOfflinePolicyEnum = pgEnum("local_offline_policy", ["fallback", "wait_then_fallback", "postpone"]);

export const agentRoleEnum = pgEnum("agent_role", ["general", "area"]);

export const agentsTable = pgTable("agents", {
  id: serial("id").primaryKey(),
  appId: integer("app_id")
    .notNull()
    .references(() => appsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  systemPrompt: text("system_prompt"),
  model: text("model").notNull().default("openrouter/auto"),
  // Modello scelto tra quelli degli Account AI; `model` (testo) resta per compatibilità durante la transizione
  aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "restrict" }),
  // Modello di riserva se l'agente locale non è disponibile
  fallbackAiModelId: integer("fallback_ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
  localOfflinePolicy: localOfflinePolicyEnum("local_offline_policy").notNull().default("fallback"),
  localOfflineWaitS: integer("local_offline_wait_s").notNull().default(30),
  // Le run di un utente diverso dal proprietario usano l'agente locale solo se attivo
  localForThirdParties: boolean("local_for_third_parties").notNull().default(false),
  status: agentStatusEnum("status").notNull().default("draft"),
  role: agentRoleEnum("role").notNull().default("area"),
  area: text("area"),
  defaultIdentity: toolIdentityEnum("default_identity").notNull().default("user"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  // Un solo agente generale per app
  uniqueIndex("agents_one_general_per_app").on(table.appId).where(sql`${table.role} = 'general'`),
]);

export const insertAgentSchema = createInsertSchema(agentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agentsTable.$inferSelect;

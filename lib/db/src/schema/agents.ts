import { pgTable, serial, integer, text, timestamp, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { appsTable } from "./apps";
import { toolIdentityEnum } from "./app-tools";

export const agentStatusEnum = pgEnum("agent_status", ["active", "inactive", "draft"]);

export const agentRoleEnum = pgEnum("agent_role", ["general", "area"]);

export const agentsTable = pgTable("agents", {
  id: serial("id").primaryKey(),
  appId: integer("app_id")
    .notNull()
    .references(() => appsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  systemPrompt: text("system_prompt"),
  model: text("model").notNull().default("openrouter/auto"),
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

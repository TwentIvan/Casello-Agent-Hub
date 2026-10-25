import { pgTable, serial, integer, text, timestamp, jsonb, unique } from "drizzle-orm/pg-core";
import { agentsTable } from "./agents";

// Skill di un agente: istruzioni operative che usano un sottoinsieme dei suoi tool (status: draft | active)
export const agentSkillsTable = pgTable(
  "agent_skills",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    instructions: text("instructions").notNull(),
    toolNames: jsonb("tool_names").$type<string[]>().notNull().default([]),
    paramsSchema: jsonb("params_schema"),
    status: text("status", { enum: ["draft", "active"] }).notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [unique("agent_skills_agent_id_name_unique").on(table.agentId, table.name)],
);

export type AgentSkill = typeof agentSkillsTable.$inferSelect;

import { pgTable, integer, primaryKey } from "drizzle-orm/pg-core";
import { agentsTable } from "./agents";
import { appToolsTable } from "./app-tools";

// Quali tool del catalogo dell'app può usare ciascun agente
export const agentToolsTable = pgTable(
  "agent_tools",
  {
    agentId: integer("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    toolId: integer("tool_id")
      .notNull()
      .references(() => appToolsTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.toolId] })],
);

export type AgentTool = typeof agentToolsTable.$inferSelect;

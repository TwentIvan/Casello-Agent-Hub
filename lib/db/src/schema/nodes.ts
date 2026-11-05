import { pgTable, serial, integer, text, timestamp, jsonb, pgEnum, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const nodeStatusEnum = pgEnum("node_status", ["active", "disabled"]);

// Nodo locale registrato: esecutore esterno (es. Claude Code sul Mac) dei compiti `node` delle squadre.
// I campi dichiarati (executor, version, skills, workspace_root, max_concurrent) li comunica il nodo stesso.
export const nodesTable = pgTable(
  "nodes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: nodeStatusEnum("status").notNull().default("active"),
    executor: text("executor"),
    version: text("version"),
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    workspaceRoot: text("workspace_root"),
    maxConcurrent: integer("max_concurrent").notNull().default(1),
    lastSeenAt: timestamp("last_seen_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [unique("nodes_user_name_unique").on(table.userId, table.name)],
);

export type Node = typeof nodesTable.$inferSelect;

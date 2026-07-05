import { pgTable, serial, integer, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { agentsTable } from "./agents";

export const httpMethodEnum = pgEnum("http_method", ["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const toolsTable = pgTable("tools", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id")
    .notNull()
    .references(() => agentsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  httpMethod: httpMethodEnum("http_method").notNull(),
  endpoint: text("endpoint").notNull(),
  parametersSchema: text("parameters_schema"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertToolSchema = createInsertSchema(toolsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTool = z.infer<typeof insertToolSchema>;
export type Tool = typeof toolsTable.$inferSelect;

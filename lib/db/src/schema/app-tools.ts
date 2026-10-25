import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  pgEnum,
  boolean,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { appsTable } from "./apps";

export const toolKindEnum = pgEnum("tool_kind", ["http", "ui", "composite"]);
export const toolIdentityEnum = pgEnum("tool_identity", ["user", "service"]);
export const toolStatusEnum = pgEnum("tool_status", ["draft", "active", "disabled"]);

// Catalogo dei tool: appartengono all'App e sono collegati agli agenti tramite agent_tools
export const appToolsTable = pgTable(
  "app_tools",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    kind: toolKindEnum("kind").notNull(),
    identity: toolIdentityEnum("identity").notNull().default("user"),
    requiresConfirmation: boolean("requires_confirmation").notNull().default(false),
    readOnly: boolean("read_only").notNull().default(false),
    status: toolStatusEnum("status").notNull().default("draft"),
    paramsSchema: jsonb("params_schema").notNull().default({ type: "object", properties: {} }),
    definition: jsonb("definition").notNull(),
    evidence: jsonb("evidence"),
    needsVerification: boolean("needs_verification").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [unique("app_tools_app_id_name_unique").on(table.appId, table.name)],
);

export const insertAppToolSchema = createInsertSchema(appToolsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAppTool = z.infer<typeof insertAppToolSchema>;
export type AppTool = typeof appToolsTable.$inferSelect;

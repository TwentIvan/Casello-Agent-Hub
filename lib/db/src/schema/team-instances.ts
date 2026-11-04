import { pgTable, serial, integer, text, timestamp, pgEnum, jsonb, unique, index, numeric } from "drizzle-orm/pg-core";
import { appsTable } from "./apps";
import { usersTable } from "./users";
import { teamTemplatesTable } from "./team-templates";
import { skillKindEnum } from "./skills";

// Forma del manifesto salvato (`validateRoles` dell'API la verifica con `InstanceRoleSchema` a ogni scrittura
// e ogni lettura la rilegge con lo stesso schema)
export type InstanceRoleData = {
  key: string;
  name: string;
  task: string;
  isLead: boolean;
  runsOn: "cloud" | "node";
  aiModelId: number | null;
  tools: number[];
  skills: Array<{ code: string; version: number }>;
  localSkills: string[];
};

export const teamInstanceStatusEnum = pgEnum("team_instance_status", ["draft", "active", "closed"]);

// Squadra legata a un lavoro di riferimento (app + tipo + id), copiata da un modello o creata da zero
export const teamInstancesTable = pgTable(
  "team_instances",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    templateId: integer("template_id").references(() => teamTemplatesTable.id, { onDelete: "set null" }),
    templateVersion: integer("template_version"),
    refAppId: integer("ref_app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "restrict" }),
    refType: text("ref_type").notNull(),
    refId: text("ref_id").notNull(),
    refTitle: text("ref_title").notNull(),
    status: teamInstanceStatusEnum("status").notNull().default("draft"),
    // Manifesto dei ruoli dell'istanza, con le skill fissate a una versione
    roles: jsonb("roles").$type<InstanceRoleData[]>().notNull().default([]),
    createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    closedAt: timestamp("closed_at"),
    // Esecuzione: chi ha attivato la squadra (riceve le voci di coda), tetto mensile in USD (null = nessuno), ultimo turno del capo
    activatedBy: integer("activated_by").references(() => usersTable.id, { onDelete: "set null" }),
    monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 12, scale: 2 }),
    lastTurnAt: timestamp("last_turn_at"),
  },
  (table) => [index("team_instances_ref_idx").on(table.refAppId, table.refType, table.refId)],
);

// Skill specializzate di una sola istanza (codice unico per istanza)
export const teamInstanceSkillsTable = pgTable(
  "team_instance_skills",
  {
    id: serial("id").primaryKey(),
    instanceId: integer("instance_id")
      .notNull()
      .references(() => teamInstancesTable.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: skillKindEnum("kind").notNull(),
    content: text("content").notNull(),
    toolHints: jsonb("tool_hints").$type<string[]>().notNull().default([]),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [unique("team_instance_skills_instance_code_unique").on(table.instanceId, table.code)],
);

export type TeamInstanceRow = typeof teamInstancesTable.$inferSelect;
export type TeamInstanceSkillRow = typeof teamInstanceSkillsTable.$inferSelect;

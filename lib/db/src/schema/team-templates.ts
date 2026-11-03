import { pgTable, serial, integer, text, timestamp, boolean, jsonb, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Modelli di squadra; il nome è unico tra i non archiviati
export const teamTemplatesTable = pgTable(
  "team_templates",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    version: integer("version").notNull().default(1),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("team_templates_name_active_unique")
      .on(table.name)
      .where(sql`${table.archived} = false`),
  ],
);

// Una riga per ogni salvataggio del modello, con il manifesto completo dei ruoli
export const teamTemplateVersionsTable = pgTable(
  "team_template_versions",
  {
    id: serial("id").primaryKey(),
    templateId: integer("template_id")
      .notNull()
      .references(() => teamTemplatesTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    manifest: jsonb("manifest").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [unique("team_template_versions_template_version_unique").on(table.templateId, table.version)],
);

export type TeamTemplateRow = typeof teamTemplatesTable.$inferSelect;
export type TeamTemplateVersionRow = typeof teamTemplateVersionsTable.$inferSelect;

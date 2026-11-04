import { pgTable, serial, integer, text, timestamp, pgEnum, boolean, jsonb, unique } from "drizzle-orm/pg-core";

export const skillKindEnum = pgEnum("skill_kind", ["casello", "node"]);

// Catalogo delle skill con codice: `casello` = istruzioni in Casello, `node` = nome della skill sul nodo
export const skillsTable = pgTable("skills", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  kind: skillKindEnum("kind").notNull(),
  currentVersion: integer("current_version").notNull().default(1),
  deprecated: boolean("deprecated").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Versioni immutabili di una skill
export const skillVersionsTable = pgTable(
  "skill_versions",
  {
    id: serial("id").primaryKey(),
    skillId: integer("skill_id")
      .notNull()
      .references(() => skillsTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    toolHints: jsonb("tool_hints").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [unique("skill_versions_skill_version_unique").on(table.skillId, table.version)],
);

export type SkillRow = typeof skillsTable.$inferSelect;
export type SkillVersionRow = typeof skillVersionsTable.$inferSelect;

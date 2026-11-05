import { pgTable, serial, integer, text, timestamp, index, customType } from "drizzle-orm/pg-core";
import { teamInstancesTable } from "./team-instances";
import { usersTable } from "./users";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// Allegato di una squadra (file messo a disposizione dei compiti dei ruoli `node`).
// `deleted_at` toglie l'allegato dall'elenco ma non ai compiti che lo citavano già.
export const teamAttachmentsTable = pgTable(
  "team_attachments",
  {
    id: serial("id").primaryKey(),
    instanceId: integer("instance_id")
      .notNull()
      .references(() => teamInstancesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    content: bytea("content").notNull(),
    uploadedBy: integer("uploaded_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [index("team_attachments_instance_idx").on(table.instanceId)],
);

export type TeamAttachment = typeof teamAttachmentsTable.$inferSelect;

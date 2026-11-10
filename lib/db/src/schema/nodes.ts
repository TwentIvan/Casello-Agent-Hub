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
    // Sottocartelle della radice comunicate con l'heartbeat (percorsi relativi): solo per la scelta in console
    workspaceFolders: jsonb("workspace_folders").$type<string[]>(),
    foldersUpdatedAt: timestamp("folders_updated_at"),
    lastSeenAt: timestamp("last_seen_at"),
    // Ultimo sondaggio dei turni delegati (`/api/node/turns/claim`)
    lastTurnPollAt: timestamp("last_turn_poll_at"),
    // Come è stato creato il nodo: app per Mac (`app`) o CLI (`cli`); null per i nodi più vecchi
    kind: text("kind"),
    pairedAt: timestamp("paired_at"),
    pairedIp: text("paired_ip"),
    // Stato di Claude Code sul Mac, comunicato con l'heartbeat
    claudeStatus: jsonb("claude_status").$type<Record<string, unknown>>(),
    claudeCheckedAt: timestamp("claude_checked_at"),
    // Impostazioni scelte in console (maxConcurrent, maxConcurrentTurns, timeout)
    settings: jsonb("settings").$type<Record<string, unknown>>(),
    diagnosticsRequestedAt: timestamp("diagnostics_requested_at"),
    uninstallRequestedAt: timestamp("uninstall_requested_at"),
    updateFailedVersion: text("update_failed_version"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [unique("nodes_user_name_unique").on(table.userId, table.name)],
);

export type Node = typeof nodesTable.$inferSelect;

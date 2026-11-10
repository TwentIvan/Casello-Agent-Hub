import { pgTable, pgEnum, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { nodesTable } from "./nodes";

export const nodePairingStatusEnum = pgEnum("node_pairing_status", [
  "pending",
  "approved",
  "denied",
  "consumed",
  "expired",
]);

// Abbinamento di un nodo dal browser: codice breve per l'utente e segreto di polling del nodo, solo hash nel DB.
export const nodePairingsTable = pgTable(
  "node_pairings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userCodeHash: text("user_code_hash").notNull().unique(),
    pollSecretHash: text("poll_secret_hash").notNull(),
    deviceName: text("device_name").notNull(),
    version: text("version").notNull(),
    status: nodePairingStatusEnum("status").notNull().default("pending"),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
    nodeId: integer("node_id").references(() => nodesTable.id, { onDelete: "cascade" }),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    // Indirizzo della richiesta abbreviato all'/24 (IPv4) o /48 (IPv6)
    requestIp: text("request_ip"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    decidedAt: timestamp("decided_at"),
  },
  (table) => [index("node_pairings_expires_idx").on(table.expiresAt)],
);

// Ultima diagnosi caricata da un nodo (una per nodo)
export const nodeDiagnosticsTable = pgTable("node_diagnostics", {
  nodeId: integer("node_id")
    .primaryKey()
    .references(() => nodesTable.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type NodePairing = typeof nodePairingsTable.$inferSelect;

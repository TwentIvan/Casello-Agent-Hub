import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Token personali (server MCP e /api): a riposo solo l'hash SHA-256 (esadecimale), il valore si mostra una volta
export const apiTokensTable = pgTable("api_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  name: text("name").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
  // Ambiti: mcp, api:read, api:write (in ordine di TOKEN_SCOPES); i token vecchi hanno solo mcp
  scopes: text("scopes").array().notNull().default(sql`'{mcp}'::text[]`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ApiToken = typeof apiTokensTable.$inferSelect;

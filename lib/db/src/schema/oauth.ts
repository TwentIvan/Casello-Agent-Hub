import { pgTable, serial, integer, text, timestamp, jsonb, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const oauthClientKindEnum = pgEnum("oauth_client_kind", ["dcr", "metadata", "embed"]);
export const oauthTokenKindEnum = pgEnum("oauth_token_kind", ["access", "refresh"]);

// Client OAuth del connettore: registrato dinamicamente (dcr) o letto da un documento di metadati (metadata)
export const oauthClientsTable = pgTable("oauth_clients", {
  id: serial("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  kind: oauthClientKindEnum("kind").notNull(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  metadataFetchedAt: timestamp("metadata_fetched_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Collegamento: consenso di un utente a un client. Al più uno non revocato per utente e client.
export const oauthGrantsTable = pgTable(
  "oauth_grants",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    clientRowId: integer("client_id")
      .notNull()
      .references(() => oauthClientsTable.id, { onDelete: "cascade" }),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    uniqueIndex("oauth_grants_active_unique")
      .on(table.userId, table.clientRowId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

// Codici d'autorizzazione: si salva solo l'hash SHA-256, uso singolo
export const oauthCodesTable = pgTable(
  "oauth_codes",
  {
    id: serial("id").primaryKey(),
    codeHash: text("code_hash").notNull().unique(),
    grantId: integer("grant_id")
      .notNull()
      .references(() => oauthGrantsTable.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
  },
  (table) => [index("oauth_codes_grant_idx").on(table.grantId)],
);

// Token di accesso e di rinnovo: solo l'hash; `used_at` conta solo per i rinnovi (già ruotati)
export const oauthTokensTable = pgTable(
  "oauth_tokens",
  {
    id: serial("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    grantId: integer("grant_id")
      .notNull()
      .references(() => oauthGrantsTable.id, { onDelete: "cascade" }),
    kind: oauthTokenKindEnum("kind").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("oauth_tokens_grant_idx").on(table.grantId)],
);

export type OAuthClient = typeof oauthClientsTable.$inferSelect;
export type OAuthGrant = typeof oauthGrantsTable.$inferSelect;
export type OAuthCode = typeof oauthCodesTable.$inferSelect;
export type OAuthToken = typeof oauthTokensTable.$inferSelect;

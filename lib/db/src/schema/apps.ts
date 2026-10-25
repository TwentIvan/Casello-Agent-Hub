import { pgTable, serial, text, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const appStatusEnum = pgEnum("app_status", ["active", "inactive"]);

// Da dove l'architetto legge il codice dell'app
export const sourceTypeEnum = pgEnum("source_type", ["github", "zip", "none"]);

export type AuthConfig = { header: string; scheme: string | null };

export const appsTable = pgTable("apps", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  baseUrl: text("base_url").notNull(),
  internalBaseUrl: text("internal_base_url"),
  // Come l'app riceve le credenziali: { header, scheme } (scheme null = valore grezzo)
  userAuth: jsonb("user_auth").$type<AuthConfig>(),
  serviceAuth: jsonb("service_auth").$type<AuthConfig>(),
  // Segreto di servizio cifrato (AES-256-GCM): mai in chiaro
  serviceSecretEnc: text("service_secret_enc"),
  // Sorgenti per l'architetto: il token GitHub (sola lettura) è cifrato, mai in chiaro
  sourceType: sourceTypeEnum("source_type").notNull().default("none"),
  sourceRepo: text("source_repo"), // formato owner/nome
  sourceBranch: text("source_branch"),
  sourceTokenEnc: text("source_token_enc"),
  openapiUrl: text("openapi_url"),
  functionalDescription: text("functional_description"),
  status: appStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAppSchema = createInsertSchema(appsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertApp = z.infer<typeof insertAppSchema>;
export type App = typeof appsTable.$inferSelect;

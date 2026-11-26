import { pgTable, serial, bigint, text, varchar, timestamp, pgEnum, jsonb, integer, boolean, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";

export const appStatusEnum = pgEnum("app_status", ["active", "inactive"]);

// Da dove l'architetto legge il codice dell'app
export const sourceTypeEnum = pgEnum("source_type", ["github", "zip", "none"]);

// Frequenza con cui si aggiorna la sintesi dell'architettura dell'App
export const architectureRefreshEnum = pgEnum("architecture_refresh", ["off", "hourly", "6h", "daily", "weekly"]);

export type AuthConfig = { header: string; scheme: string | null };

// Header HTTP fisso (non segreto) che l'esecutore manda su ogni chiamata ai tool dell'app
export type ExtraHeader = { name: string; value: string };

// Azione proposta dal plugin su una pagina dell'app ospite
export type PageAction = { page: string; label: string; request: string };

export const appsTable = pgTable(
  "apps",
  {
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
    // Header fissi (non segreti) su ogni chiamata ai tool, HTTP e MCP, con entrambe le identità
    extraHeaders: jsonb("extra_headers").$type<ExtraHeader[]>().notNull().default([]),
    // Sorgenti per l'architetto: il token GitHub (sola lettura) è cifrato, mai in chiaro
    sourceType: sourceTypeEnum("source_type").notNull().default("none"),
    sourceRepo: text("source_repo"), // formato owner/nome
    sourceBranch: text("source_branch"),
    sourceTokenEnc: text("source_token_enc"),
    // Installazione dell'App GitHub di Casello da cui si legge il repo (alternativa al token)
    sourceInstallationId: bigint("source_installation_id", { mode: "number" }),
    openapiUrl: text("openapi_url"),
    // Server MCP dell'app (se espone i suoi strumenti via MCP)
    mcpUrl: text("mcp_url"),
    functionalDescription: text("functional_description"),
    architectureRefresh: architectureRefreshEnum("architecture_refresh").notNull().default("6h"),
    // Rianalisi automatica: a ogni nuovo commit del branch base un'analisi con l'agente locale (issue #113)
    autoReanalysis: boolean("auto_reanalysis").notNull().default(false),
    // Ultimo SHA del branch base già gestito dalla rianalisi automatica e ora dell'ultimo controllo
    reanalysisSeenSha: text("reanalysis_seen_sha"),
    reanalysisCheckedAt: timestamp("reanalysis_checked_at"),
    // Versione di prova (lavoro su branch unico): branch riscritto da Botcave a ogni lavoro e indirizzo dove la CI/Coolify lo pubblica
    stagingBranch: text("staging_branch"),
    stagingUrl: text("staging_url"),
    // Collaudo dei lavori: ricetta corrente (versioni in `app_test_recipes`) e correzione automatica dei problemi
    testRecipe: jsonb("test_recipe"),
    testRecipeVersion: integer("test_recipe_version").notNull().default(0),
    testAutoFix: boolean("test_auto_fix").notNull().default(false),
    bugReportsEnabled: boolean("bug_reports_enabled").notNull().default(false),
    bugReportsDailyLimit: integer("bug_reports_daily_limit").notNull().default(20),
    identitySecretEnc: text("identity_secret_enc"),
    identitySecretSetAt: timestamp("identity_secret_set_at"),
    // Nomi dei bot mostrati nel plugin (null = predefiniti)
    alfredName: varchar("alfred_name", { length: 40 }),
    luciusName: varchar("lucius_name", { length: 40 }),
    leadName: varchar("lead_name", { length: 40 }),
    pageActions: jsonb("page_actions").$type<PageAction[]>().notNull().default([]),
    // Pagine dell'app ospite viste dal plugin (setContext)
    embedPagesSeen: jsonb("embed_pages_seen").$type<string[]>().notNull().default([]),
    status: appStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [check("apps_bug_reports_daily_limit_check", sql`${table.bugReportsDailyLimit} between 1 and 500`)],
);

export const insertAppSchema = createInsertSchema(appsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertApp = z.infer<typeof insertAppSchema>;
export type App = typeof appsTable.$inferSelect;

import { pgTable, pgEnum, serial, integer, text, timestamp, jsonb, numeric, boolean, customType, unique, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appsTable } from "./apps";
import { teamInstancesTable } from "./team-instances";
import { teamWorksTable } from "./team-works";
import { aiModelsTable } from "./ai-models";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const releaseTestStatusEnum = pgEnum("release_test_status", ["queued", "dispatching", "running", "done", "failed", "skipped", "cancelled"]);
export const releaseTestOutcomeEnum = pgEnum("release_test_outcome", ["ok", "problems", "not_startable"]);
export const releaseTestModeEnum = pgEnum("release_test_mode", ["full", "relight"]);
export const releaseTestCommandStatusEnum = pgEnum("release_test_command_status", ["pending", "sent", "done", "failed", "expired"]);
export const releaseTestFileKindEnum = pgEnum("release_test_file_kind", ["video", "screenshot"]);
export const appTestRecipeSourceEnum = pgEnum("app_test_recipe_source", ["agent", "user"]);

// Collaudo di un lavoro prima di «Porta in produzione» (spec 2026-11-26-botcave-collaudo-rilascio §5)
export const releaseTestsTable = pgTable(
  "release_tests",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    workId: integer("work_id")
      .notNull()
      .references(() => teamWorksTable.id, { onDelete: "cascade" }),
    instanceId: integer("instance_id")
      .notNull()
      .references(() => teamInstancesTable.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    mode: releaseTestModeEnum("mode").notNull().default("full"),
    status: releaseTestStatusEnum("status").notNull().default("queued"),
    outcome: releaseTestOutcomeEnum("outcome"),
    report: text("report"),
    problems: jsonb("problems"),
    notTestable: jsonb("not_testable"),
    // Messaggio fisso, mai testo del runner
    error: text("error"),
    codeHash: text("code_hash"),
    codeExpiresAt: timestamp("code_expires_at"),
    tokenHash: text("token_hash"),
    tokenExpiresAt: timestamp("token_expires_at"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    githubRunId: text("github_run_id"),
    tunnelUrl: text("tunnel_url"),
    tunnelUntil: timestamp("tunnel_until"),
    aiModelId: integer("ai_model_id").references(() => aiModelsTable.id, { onDelete: "set null" }),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    // Costo in USD, null se un prezzo del modello manca
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    // Un solo collaudo aperto per App
    uniqueIndex("release_tests_one_open_per_app")
      .on(table.appId)
      .where(sql`${table.status} in ('queued', 'dispatching', 'running')`),
    index("release_tests_status_created_idx").on(table.status, table.createdAt),
    index("release_tests_work_idx").on(table.workId),
  ],
);

// Passi del collaudo: stessa forma di `team_task_steps`
export const releaseTestStepsTable = pgTable(
  "release_test_steps",
  {
    id: serial("id").primaryKey(),
    testId: integer("test_id")
      .notNull()
      .references(() => releaseTestsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: text("type").notNull(),
    toolName: text("tool_name"),
    args: jsonb("args"),
    ok: boolean("ok"),
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("release_test_steps_test_id_position_idx").on(table.testId, table.position)],
);

// Comandi dall'agente di collaudo al runner (uscita ripulita)
export const releaseTestCommandsTable = pgTable(
  "release_test_commands",
  {
    id: serial("id").primaryKey(),
    testId: integer("test_id")
      .notNull()
      .references(() => releaseTestsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    args: jsonb("args"),
    status: releaseTestCommandStatusEnum("status").notNull().default("pending"),
    output: text("output"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    sentAt: timestamp("sent_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [index("release_test_commands_test_status_idx").on(table.testId, table.status)],
);

// Video e screenshot del collaudo (cancellati dopo 30 giorni)
export const releaseTestFilesTable = pgTable(
  "release_test_files",
  {
    id: serial("id").primaryKey(),
    testId: integer("test_id")
      .notNull()
      .references(() => releaseTestsTable.id, { onDelete: "cascade" }),
    kind: releaseTestFileKindEnum("kind").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    content: bytea("content").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("release_test_files_test_idx").on(table.testId), index("release_test_files_created_idx").on(table.createdAt)],
);

// Versioni della ricetta di collaudo di un'App
export const appTestRecipesTable = pgTable(
  "app_test_recipes",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    recipe: jsonb("recipe").notNull(),
    source: appTestRecipeSourceEnum("source").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [unique("app_test_recipes_app_version_unique").on(table.appId, table.version)],
);

export type ReleaseTestRow = typeof releaseTestsTable.$inferSelect;
export type ReleaseTestCommandRow = typeof releaseTestCommandsTable.$inferSelect;
export type ReleaseTestFileRow = typeof releaseTestFilesTable.$inferSelect;

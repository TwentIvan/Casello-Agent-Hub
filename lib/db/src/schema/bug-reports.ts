import { pgTable, pgEnum, serial, integer, text, timestamp, jsonb, index, unique } from "drizzle-orm/pg-core";
import { appsTable } from "./apps";
import { runsTable } from "./runs";
import { pendingActionsTable } from "./pending-actions";
import { teamInstancesTable } from "./team-instances";

export const bugReportStatusEnum = pgEnum("bug_report_status", [
  "received",
  "triage",
  "needs_info",
  "pending_approval",
  "in_progress",
  "fixed",
  "not_a_bug",
  "duplicate",
  "rejected",
]);
export const bugReporterKindEnum = pgEnum("bug_reporter_kind", ["identity", "browser"]);
export const bugMessageAuthorEnum = pgEnum("bug_message_author", ["reporter", "lead", "owner"]);

// Esito del vaglio del Responsabile
export type BugTriage = {
  verdict: "bug" | "dettagli" | "doppione" | "non_bug" | "inconcluso";
  summary: string;
  question?: string;
  duplicateOf?: number;
  userMessage?: string;
  runId?: number;
};

// Contesto della pagina da cui parte la segnalazione (indirizzo senza query)
export type BugPageContext = { page?: string; id?: string; title?: string; url?: string };

// Segnalazione di un bug da un'app ospite (numerata per App)
export const bugReportsTable = pgTable(
  "bug_reports",
  {
    id: serial("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    reporterKind: bugReporterKindEnum("reporter_kind").notNull(),
    reporterSub: text("reporter_sub"),
    reporterName: text("reporter_name"),
    reporterEmail: text("reporter_email"),
    // SHA-256 della chiave del browser (segnalanti anonimi)
    browserKeyHash: text("browser_key_hash"),
    ipPrefix: text("ip_prefix"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    steps: text("steps"),
    expected: text("expected"),
    pageContext: jsonb("page_context").$type<BugPageContext>(),
    status: bugReportStatusEnum("status").notNull().default("received"),
    // La frase che vede l'utente
    publicMessage: text("public_message"),
    triage: jsonb("triage").$type<BugTriage>(),
    triageRunId: integer("triage_run_id").references(() => runsTable.id, { onDelete: "set null" }),
    pendingActionId: integer("pending_action_id").references(() => pendingActionsTable.id, { onDelete: "set null" }),
    teamInstanceId: integer("team_instance_id").references(() => teamInstancesTable.id, { onDelete: "set null" }),
    issueNumber: integer("issue_number"),
    issueUrl: text("issue_url"),
    prUrl: text("pr_url"),
    reporterSeenAt: timestamp("reporter_seen_at"),
    statusChangedAt: timestamp("status_changed_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("bug_reports_app_number_uniq").on(table.appId, table.number),
    index("bug_reports_app_status_idx").on(table.appId, table.status),
    index("bug_reports_app_sub_idx").on(table.appId, table.reporterSub),
    index("bug_reports_app_key_idx").on(table.appId, table.browserKeyHash),
    index("bug_reports_triage_run_idx").on(table.triageRunId),
  ],
);

// Scambio di messaggi su una segnalazione (domande del Responsabile, risposte, note)
export const bugReportMessagesTable = pgTable(
  "bug_report_messages",
  {
    id: serial("id").primaryKey(),
    reportId: integer("report_id")
      .notNull()
      .references(() => bugReportsTable.id, { onDelete: "cascade" }),
    author: bugMessageAuthorEnum("author").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("bug_report_messages_report_idx").on(table.reportId, table.createdAt)],
);

export type BugReportRow = typeof bugReportsTable.$inferSelect;
export type BugReportMessageRow = typeof bugReportMessagesTable.$inferSelect;

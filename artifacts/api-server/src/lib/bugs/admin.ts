import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { appsTable, bugReportMessagesTable, bugReportsTable, db, pendingActionsTable, type BugReportRow } from "@workspace/db";
import { dayStart } from "../budget";
import { encryptSecret } from "../secrets";
import { approverFor, designatedBugTeam } from "./approval";
import { appIdentitySecret, generateIdentitySecret, verifyIdentityToken } from "./identity";
import { BUG_LIMITS, BUG_MESSAGES, BUG_STATUS_LABELS, BugError, type BugReportStatus } from "./messages";
import { cleanBugText, setStatus } from "./reports";

// Lato amministratore delle segnalazioni: impostazioni, segreto d'identità, elenco, dettaglio, messaggi e chiusura.

export const ADMIN_BUG_LIST_MAX = 200;
export const APP_NOT_FOUND = "App non trovata";
export const CLOSE_NOTE = "chiusa dall'amministratore";
const FINAL: BugReportStatus[] = ["fixed", "not_a_bug", "duplicate", "rejected"];
export const ADMIN_BUG_MESSAGES = {
  approvalInProgress: "approvazione in corso: riprova tra poco",
  closed: "segnalazione chiusa",
} as const;
const CLOSABLE: BugReportStatus[] = ["received", "triage", "needs_info", "pending_approval", "in_progress"];

const appNotFound = () => new BugError(404, APP_NOT_FOUND);

export async function bugSettings(appId: number) {
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, appId));
  if (!app) throw appNotFound();
  const [team, approver] = await Promise.all([designatedBugTeam(appId), approverFor(appId)]);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bugReportsTable)
    .where(and(eq(bugReportsTable.appId, appId), gte(bugReportsTable.createdAt, dayStart())));
  return {
    enabled: app.bugReportsEnabled,
    dailyLimit: app.bugReportsDailyLimit,
    identitySecretSet: app.identitySecretEnc !== null,
    identitySecretSetAt: app.identitySecretSetAt,
    bugTeam: team ? { id: team.id, name: team.name, status: team.status } : null,
    // Qualcuno riceverebbe la voce in «Da confermare» (stessa regola di ensureApprovalItem)
    approverAvailable: approver !== null,
    todayCount: n!,
  };
}

export async function updateBugSettings(appId: number, patch: { enabled?: boolean; dailyLimit?: number }) {
  const set: Partial<typeof appsTable.$inferInsert> = {};
  if (patch.enabled !== undefined) set.bugReportsEnabled = patch.enabled;
  if (patch.dailyLimit !== undefined) {
    if (!Number.isInteger(patch.dailyLimit) || patch.dailyLimit < 1 || patch.dailyLimit > 500) {
      throw new BugError(400, "limite giornaliero non valido: da 1 a 500");
    }
    set.bugReportsDailyLimit = patch.dailyLimit;
  }
  if (Object.keys(set).length > 0) {
    const rows = await db.update(appsTable).set(set).where(eq(appsTable.id, appId)).returning({ id: appsTable.id });
    if (rows.length === 0) throw appNotFound();
  }
  return bugSettings(appId);
}

/** Genera (o rigenera) il segreto d'identità: si restituisce in chiaro una sola volta, nel DB resta cifrato. */
export async function setIdentitySecret(appId: number): Promise<string> {
  const secret = generateIdentitySecret();
  const rows = await db
    .update(appsTable)
    .set({ identitySecretEnc: encryptSecret(secret), identitySecretSetAt: new Date() })
    .where(eq(appsTable.id, appId))
    .returning({ id: appsTable.id });
  if (rows.length === 0) throw appNotFound();
  return secret;
}

export async function clearIdentitySecret(appId: number): Promise<void> {
  const rows = await db
    .update(appsTable)
    .set({ identitySecretEnc: null, identitySecretSetAt: null })
    .where(eq(appsTable.id, appId))
    .returning({ id: appsTable.id });
  if (rows.length === 0) throw appNotFound();
}

export type IdentityTestResult = {
  valid: boolean;
  reason: "invalid" | "expired" | "no_secret" | null;
  sub: string | null;
  name: string | null;
  email: string | null;
  expiresAt: Date | null;
};

/** Verifica un token con il segreto dell'App, senza salvare nulla. */
export async function testIdentity(appId: number, token: string): Promise<IdentityTestResult> {
  const [app] = await db.select({ slug: appsTable.slug }).from(appsTable).where(eq(appsTable.id, appId));
  if (!app) throw appNotFound();
  const none = { sub: null, name: null, email: null, expiresAt: null };
  const secret = await appIdentitySecret(appId);
  if (!secret) return { valid: false, reason: "no_secret", ...none };
  const check = verifyIdentityToken(token, secret, app.slug);
  if (!check.ok) return { valid: false, reason: check.reason, ...none };
  const { sub, name, email, expiresAt } = check.identity;
  return { valid: true, reason: null, sub, name, email, expiresAt };
}

function reporterLabel(row: BugReportRow): string {
  if (row.reporterName) return row.reporterName;
  return row.reporterKind === "identity" ? "Utente con identità" : "Visitatore";
}

function summary(row: BugReportRow) {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    statusLabel: BUG_STATUS_LABELS[row.status],
    publicMessage: row.publicMessage,
    unseen: false,
    createdAt: row.createdAt,
    statusChangedAt: row.statusChangedAt,
    reporterLabel: reporterLabel(row),
  };
}

export async function listAppBugs(appId: number, status?: BugReportStatus) {
  const rows = await db
    .select()
    .from(bugReportsTable)
    .where(status ? and(eq(bugReportsTable.appId, appId), eq(bugReportsTable.status, status)) : eq(bugReportsTable.appId, appId))
    .orderBy(desc(bugReportsTable.createdAt), desc(bugReportsTable.id))
    .limit(ADMIN_BUG_LIST_MAX);
  return rows.map(summary);
}

async function detailOf(row: BugReportRow) {
  const messages = await db
    .select({ id: bugReportMessagesTable.id, author: bugReportMessagesTable.author, content: bugReportMessagesTable.content, createdAt: bugReportMessagesTable.createdAt })
    .from(bugReportMessagesTable)
    .where(eq(bugReportMessagesTable.reportId, row.id))
    .orderBy(asc(bugReportMessagesTable.createdAt), asc(bugReportMessagesTable.id));
  let pendingActionNumber: number | null = null;
  if (row.pendingActionId !== null) {
    const [item] = await db.select({ number: pendingActionsTable.number }).from(pendingActionsTable).where(eq(pendingActionsTable.id, row.pendingActionId));
    pendingActionNumber = item?.number ?? null;
  }
  const t = row.triage;
  return {
    ...summary(row),
    description: row.description,
    steps: row.steps,
    expected: row.expected,
    reporterKind: row.reporterKind,
    reporterName: row.reporterName,
    reporterEmail: row.reporterEmail,
    pageContext: row.pageContext,
    triage: t ? { verdict: t.verdict, summary: t.summary, question: t.question, duplicateOf: t.duplicateOf, userMessage: t.userMessage } : null,
    pendingActionNumber,
    teamInstanceId: row.teamInstanceId,
    issueNumber: row.issueNumber,
    issueUrl: row.issueUrl,
    prUrl: row.prUrl,
    messages,
  };
}

export type AdminBugDetail = Awaited<ReturnType<typeof detailOf>>;

async function findByNumber(appId: number, number: number): Promise<BugReportRow> {
  const [row] = await db
    .select()
    .from(bugReportsTable)
    .where(and(eq(bugReportsTable.appId, appId), eq(bugReportsTable.number, number)));
  if (!row) throw new BugError(404, BUG_MESSAGES.notFound);
  return row;
}

export async function getAppBug(appId: number, number: number): Promise<AdminBugDetail> {
  return detailOf(await findByNumber(appId, number));
}

/** Messaggio dell'amministratore al segnalante: visibile nel plugin, non cambia lo stato. */
export async function addOwnerMessage(appId: number, number: number, content: string) {
  const text = cleanBugText(content, BUG_LIMITS.message, true)!;
  const row = await findByNumber(appId, number);
  if (FINAL.includes(row.status)) throw new BugError(409, ADMIN_BUG_MESSAGES.closed);
  const [msg] = await db
    .insert(bugReportMessagesTable)
    .values({ reportId: row.id, author: "owner", content: text })
    .returning({ id: bugReportMessagesTable.id, author: bugReportMessagesTable.author, content: bugReportMessagesTable.content, createdAt: bugReportMessagesTable.createdAt });
  return msg!;
}

/**
 * Chiude una segnalazione non finale. Una voce `bug` ancora `pending` si rifiuta con la nota fissa, senza passare da
 * `rejectBug` (la segnalazione si chiude qui). Ordine dei lock: segnalazione → voce.
 */
export async function closeAppBug(
  appId: number,
  number: number,
  status: "fixed" | "not_a_bug",
  message?: string | null,
  userId: number | null = null,
): Promise<AdminBugDetail> {
  // Messaggio vuoto o di soli spazi = nessun messaggio: «fixed» usa la frase fissa, «not_a_bug» l'etichetta dello stato
  const custom = message ? cleanBugText(message, BUG_LIMITS.publicMessage, false) : null;
  const publicMessage = custom ?? (status === "fixed" ? BUG_MESSAGES.fixedMessage : BUG_STATUS_LABELS[status]);
  const closed = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(bugReportsTable)
      .where(and(eq(bugReportsTable.appId, appId), eq(bugReportsTable.number, number)))
      .for("update");
    if (!locked) throw new BugError(404, BUG_MESSAGES.notFound);
    if (locked.pendingActionId !== null) {
      const [item] = await tx
        .select({ status: pendingActionsTable.status })
        .from(pendingActionsTable)
        .where(eq(pendingActionsTable.id, locked.pendingActionId));
      if (item?.status === "executing") throw new BugError(409, ADMIN_BUG_MESSAGES.approvalInProgress);
    }
    const row = await setStatus(tx, locked.id, CLOSABLE, status, { publicMessage });
    if (!row) throw new BugError(409, BUG_MESSAGES.notClosable);
    if (locked.pendingActionId !== null) {
      await tx
        .update(pendingActionsTable)
        .set({ status: "rejected", decidedBy: userId, decidedAt: new Date(), decisionNote: CLOSE_NOTE })
        .where(and(eq(pendingActionsTable.id, locked.pendingActionId), eq(pendingActionsTable.status, "pending")));
    }
    return row;
  });
  return detailOf(closed);
}

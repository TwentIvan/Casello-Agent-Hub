import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, max, ne, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  appsTable,
  bugReportMessagesTable,
  bugReportsTable,
  type App,
  type BugPageContext,
  type BugReportRow,
} from "@workspace/db";
import { scrubSummary } from "../architecture/prompts";
import { dayStart } from "../budget";
import { abbreviateIp } from "../nodes/pairing";
import { consumeBugMessage } from "../../middlewares/rate-limit";
import { BUG_LIMITS, BUG_MESSAGES, BUG_STATUS_LABELS, BugError, type BugReportStatus } from "./messages";
import { startTriage } from "./triage";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Tx | typeof db;

export type Requester =
  | { kind: "identity"; sub: string; name: string | null; email: string | null }
  | { kind: "browser"; keyHash: string };

export type BugInput = {
  title: string;
  description: string;
  steps?: string;
  expected?: string;
  pageContext?: { page?: string; id?: string; title?: string; url?: string };
};

export type VisitorReportSummary = {
  id: number;
  number: number;
  title: string;
  status: BugReportStatus;
  statusLabel: string;
  publicMessage: string | null;
  unseen: boolean;
  createdAt: Date;
  statusChangedAt: Date;
};

export type VisitorReportDetail = VisitorReportSummary & {
  description: string;
  steps: string | null;
  expected: string | null;
  messages: { author: "reporter" | "lead" | "owner"; content: string; createdAt: Date }[];
};

/** Hash della chiave del browser, come si salva in `browser_key_hash`. */
export function hashBrowserKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// Caratteri di controllo ammessi: solo a capo e tabulazione
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Testo dell'utente pronto da salvare: a capo uniformati, spazi ai bordi tolti, lunghezza e caratteri di controllo
 * verificati, parole che sembrano credenziali sostituite con `***`. Vuoto: null se facoltativo, altrimenti 400.
 */
export function cleanBugText(value: string, max: number, required: boolean): string | null {
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) {
    if (required) throw new BugError(400, BUG_MESSAGES.invalidText);
    return null;
  }
  if (text.length > max || CONTROL_CHARS.test(text)) throw new BugError(400, BUG_MESSAGES.invalidText);
  return scrubSummary(text);
}

/** Indirizzo della pagina senza credenziali, query e frammento: solo http/https, al più 500 caratteri. */
export function cleanPageUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const out = url.toString();
  return out.length <= BUG_LIMITS.pageUrl ? out : null;
}

function cleanPageContext(ctx: BugInput["pageContext"]): BugPageContext | null {
  if (!ctx) return null;
  const out: BugPageContext = {};
  const line = (v: string | undefined, max: number) => {
    const t = v?.replace(/\s+/g, " ").trim();
    return t && t.length <= max && !CONTROL_CHARS.test(t) ? scrubSummary(t) : undefined;
  };
  const page = line(ctx.page, 40);
  const id = line(ctx.id, 40);
  const title = line(ctx.title, 200);
  const url = cleanPageUrl(ctx.url);
  if (page) out.page = page;
  if (id) out.id = id;
  if (title) out.title = title;
  if (url) out.url = url;
  return Object.keys(out).length > 0 ? out : null;
}

/** Condizione che limita le righe a quelle del richiedente. */
function ownedBy(r: Requester): SQL {
  return r.kind === "identity"
    ? and(eq(bugReportsTable.reporterKind, "identity"), eq(bugReportsTable.reporterSub, r.sub))!
    : and(eq(bugReportsTable.reporterKind, "browser"), eq(bugReportsTable.browserKeyHash, r.keyHash))!;
}

/**
 * Registra una segnalazione. Numero per App con la riga dell'App bloccata; limiti giornalieri (App e richiedente)
 * ricontrollati nella stessa transazione. Il vaglio parte dopo il commit.
 */
export async function createBugReport(
  app: App,
  requester: Requester,
  input: BugInput,
  ip: string | null,
  now: Date = new Date(),
): Promise<BugReportRow> {
  const title = cleanBugText(input.title, BUG_LIMITS.title, true)!;
  const description = cleanBugText(input.description, BUG_LIMITS.description, true)!;
  const steps = cleanBugText(input.steps ?? "", BUG_LIMITS.steps, false);
  const expected = cleanBugText(input.expected ?? "", BUG_LIMITS.expected, false);
  const pageContext = cleanPageContext(input.pageContext);
  const since = dayStart(now);

  const row = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(appsTable).where(eq(appsTable.id, app.id)).for("update");
    if (!locked) throw new BugError(404, BUG_MESSAGES.unavailable);

    const [{ n: appToday }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(bugReportsTable)
      .where(and(eq(bugReportsTable.appId, app.id), gte(bugReportsTable.createdAt, since)));
    if (appToday! >= locked.bugReportsDailyLimit) throw new BugError(429, BUG_MESSAGES.dailyLimit);

    const [{ n: mineToday }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(bugReportsTable)
      .where(and(eq(bugReportsTable.appId, app.id), ownedBy(requester), gte(bugReportsTable.createdAt, since)));
    if (mineToday! >= BUG_LIMITS.perRequesterPerDay) throw new BugError(429, BUG_MESSAGES.dailyLimit);

    const [{ last }] = await tx
      .select({ last: max(bugReportsTable.number) })
      .from(bugReportsTable)
      .where(eq(bugReportsTable.appId, app.id));

    const [created] = await tx
      .insert(bugReportsTable)
      .values({
        appId: app.id,
        number: (last ?? 0) + 1,
        reporterKind: requester.kind,
        reporterSub: requester.kind === "identity" ? requester.sub : null,
        reporterName: requester.kind === "identity" ? requester.name : null,
        reporterEmail: requester.kind === "identity" ? requester.email : null,
        browserKeyHash: requester.kind === "browser" ? requester.keyHash : null,
        ipPrefix: abbreviateIp(ip ?? undefined),
        title,
        description,
        steps,
        expected,
        pageContext,
      })
      .returning();
    return created!;
  });

  await startTriage(row.id);
  return row;
}

/** Ultimo messaggio di Botcave (lead/owner) per ciascuna segnalazione. */
async function lastStaffMessages(ids: number[]): Promise<Map<number, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ reportId: bugReportMessagesTable.reportId, at: max(bugReportMessagesTable.createdAt) })
    .from(bugReportMessagesTable)
    .where(and(inArray(bugReportMessagesTable.reportId, ids), ne(bugReportMessagesTable.author, "reporter")))
    .groupBy(bugReportMessagesTable.reportId);
  return new Map(rows.filter((r) => r.at).map((r) => [r.reportId, r.at!]));
}

/** «Non letta»: stato oltre il vaglio iniziale e novità (stato o messaggio) dopo l'ultima lettura. */
function isUnseen(row: BugReportRow, lastStaff: Date | undefined): boolean {
  if (row.status === "received" || row.status === "triage") return false;
  const changed = lastStaff && lastStaff > row.statusChangedAt ? lastStaff : row.statusChangedAt;
  return changed > (row.reporterSeenAt ?? row.createdAt);
}

function summarize(row: BugReportRow, lastStaff: Date | undefined): VisitorReportSummary {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    statusLabel: BUG_STATUS_LABELS[row.status],
    publicMessage: row.publicMessage,
    unseen: isUnseen(row, lastStaff),
    createdAt: row.createdAt,
    statusChangedAt: row.statusChangedAt,
  };
}

export async function listForRequester(appId: number, r: Requester): Promise<VisitorReportSummary[]> {
  const rows = await db
    .select()
    .from(bugReportsTable)
    .where(and(eq(bugReportsTable.appId, appId), ownedBy(r)))
    .orderBy(desc(bugReportsTable.createdAt), desc(bugReportsTable.id))
    .limit(BUG_LIMITS.listMax);
  const staff = await lastStaffMessages(rows.map((x) => x.id));
  return rows.map((x) => summarize(x, staff.get(x.id)));
}

async function detailOf(row: BugReportRow): Promise<VisitorReportDetail> {
  const messages = await db
    .select({ author: bugReportMessagesTable.author, content: bugReportMessagesTable.content, createdAt: bugReportMessagesTable.createdAt })
    .from(bugReportMessagesTable)
    .where(eq(bugReportMessagesTable.reportId, row.id))
    .orderBy(asc(bugReportMessagesTable.createdAt), asc(bugReportMessagesTable.id));
  const lastStaff = messages.filter((m) => m.author !== "reporter").at(-1)?.createdAt;
  return {
    ...summarize(row, lastStaff),
    description: row.description,
    steps: row.steps,
    expected: row.expected,
    messages,
  };
}

export async function getForRequester(appId: number, r: Requester, id: number): Promise<VisitorReportDetail | null> {
  const [row] = await db
    .select()
    .from(bugReportsTable)
    .where(and(eq(bugReportsTable.id, id), eq(bugReportsTable.appId, appId), ownedBy(r)));
  return row ? detailOf(row) : null;
}

/** Risposta del segnalante a una domanda del Responsabile: solo in `needs_info`; rimette in `triage`. */
export async function addReporterMessage(appId: number, r: Requester, id: number, content: string): Promise<VisitorReportDetail> {
  const text = cleanBugText(content, BUG_LIMITS.message, true)!;
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(bugReportsTable)
      .where(and(eq(bugReportsTable.id, id), eq(bugReportsTable.appId, appId), ownedBy(r)))
      .for("update");
    if (!row) throw new BugError(404, BUG_MESSAGES.notFound);
    if (row.status !== "needs_info") throw new BugError(409, BUG_MESSAGES.notWaiting);
    if (!consumeBugMessage(id)) throw new BugError(429, BUG_MESSAGES.tooMany);
    await tx.insert(bugReportMessagesTable).values({ reportId: id, author: "reporter", content: text });
    return (await setStatus(tx, id, ["needs_info"], "triage"))!;
  });
  await startTriage(id);
  return detailOf(updated);
}

/** Segna come lette le segnalazioni del richiedente; risponde con quante ne ha toccate. */
export async function markSeen(appId: number, r: Requester, ids: number[]): Promise<number> {
  if (ids.length > BUG_LIMITS.listMax) throw new BugError(400, BUG_MESSAGES.invalidText);
  if (ids.length === 0) return 0;
  const rows = await db
    .update(bugReportsTable)
    .set({ reporterSeenAt: sql`now()` })
    .where(and(eq(bugReportsTable.appId, appId), inArray(bugReportsTable.id, ids), ownedBy(r)))
    .returning({ id: bugReportsTable.id });
  return rows.length;
}

/**
 * Cambio di stato condizionato: scrive solo se la segnalazione è in uno degli stati `from`.
 * Aggiorna `status_changed_at` e `updated_at`; null se la condizione non regge.
 */
export async function setStatus(
  tx: Executor,
  reportId: number,
  from: BugReportStatus[],
  to: BugReportStatus,
  patch: Partial<BugReportRow> = {},
): Promise<BugReportRow | null> {
  // Orologio del DB, lo stesso dei default `created_at` dei messaggi: i confronti di «non letta» restano coerenti
  const [row] = await tx
    .update(bugReportsTable)
    .set({ ...patch, status: to, statusChangedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(bugReportsTable.id, reportId), inArray(bugReportsTable.status, from)))
    .returning();
  return row ?? null;
}

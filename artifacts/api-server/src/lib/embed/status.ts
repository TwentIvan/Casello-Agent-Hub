// Stato del pannello incorporato per una pagina: contatori, azioni del tipo di pagina, disponibilità del Responsabile.
// Registra anche i tipi di pagina visti (`apps.embed_pages_seen`), per proporre le azioni in console. Log: niente.

import {
  db,
  appsTable,
  bugReportsTable,
  leadConversationsTable,
  leadMessagesTable,
  pendingActionsTable,
  runsTable,
  type App,
} from "@workspace/db";
import { and, count, eq, inArray, isNull, or } from "drizzle-orm";
import { resolveBotNames, type BotNames } from "../apps/bot-names";
import { DEFAULT_HOST_APP_SLUG } from "./host-app";
import { resolveLeadChat } from "../lead-chat/service";

export const PAGE_SEEN_WRITE_MS = 60_000;
export const PAGE_SEEN_MAX = 50;

export type EmbedStatus = {
  pending: number;
  bugs: number;
  actions: { label: string }[];
  leadAvailable: boolean;
  leadWorking: boolean;
  botNames: BotNames;
};

// Ultima scrittura per App (in memoria): al più una al minuto, anche se il tipo di pagina cambia di continuo
const lastSeenWrite = new Map<number, number>();

/** Solo per i test. */
export function resetPageSeen(): void {
  lastSeenWrite.clear();
}

/**
 * Ricorda che il pannello ha visto un tipo di pagina: elenco senza ripetizioni, più recente in testa, al più 50.
 * Scrive solo se è passato almeno un minuto dall'ultima scrittura dell'App e il tipo non è già in testa.
 */
export async function recordPageSeen(appId: number, page: string, now: number = Date.now()): Promise<void> {
  const last = lastSeenWrite.get(appId);
  if (last !== undefined && now - last < PAGE_SEEN_WRITE_MS) return;
  lastSeenWrite.set(appId, now);
  const [row] = await db.select({ seen: appsTable.embedPagesSeen }).from(appsTable).where(eq(appsTable.id, appId)).limit(1);
  if (!row || row.seen[0] === page) return;
  const next = [page, ...row.seen.filter((p) => p !== page)].slice(0, PAGE_SEEN_MAX);
  await db.update(appsTable).set({ embedPagesSeen: next }).where(eq(appsTable.id, appId));
}

/** Segnalazioni dell'App nuove o da vagliare (stati `received` e `triage`). */
async function bugsToTriage(appId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(bugReportsTable)
    .where(and(eq(bugReportsTable.appId, appId), inArray(bugReportsTable.status, ["received", "triage"])));
  return row?.n ?? 0;
}

/** C'è una run del Responsabile `pending` o `running` legata a un messaggio di una conversazione dell'utente su quell'App. */
async function leadIsWorking(userId: number, app: App): Promise<boolean> {
  const onApp =
    app.slug === DEFAULT_HOST_APP_SLUG
      ? or(eq(leadConversationsTable.appId, app.id), isNull(leadConversationsTable.appId))
      : eq(leadConversationsTable.appId, app.id);
  const [row] = await db
    .select({ n: count() })
    .from(leadMessagesTable)
    .innerJoin(leadConversationsTable, eq(leadMessagesTable.conversationId, leadConversationsTable.id))
    .innerJoin(runsTable, eq(leadMessagesTable.runId, runsTable.id))
    .where(and(eq(leadConversationsTable.userId, userId), onApp, inArray(runsTable.status, ["pending", "running"])));
  return (row?.n ?? 0) > 0;
}

export async function embedStatus(userId: number, app: App, page: string): Promise<EmbedStatus> {
  const [pendingRow] = await db
    .select({ n: count() })
    .from(pendingActionsTable)
    .where(and(eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.status, "pending")));
  const [bugs, lead, leadWorking] = await Promise.all([bugsToTriage(app.id), resolveLeadChat(userId, app.id), leadIsWorking(userId, app)]);
  return {
    pending: pendingRow?.n ?? 0,
    bugs,
    actions: app.pageActions.filter((a) => a.page === page).map((a) => ({ label: a.label })),
    leadAvailable: lead.available,
    leadWorking,
    botNames: resolveBotNames(app),
  };
}

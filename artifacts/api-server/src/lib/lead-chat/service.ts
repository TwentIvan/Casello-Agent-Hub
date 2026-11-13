// Chat con il Responsabile di prodotto di Botcave (agente `general` dell'App `casello`): ogni messaggio è una run del
// Responsabile con la cronologia recente nell'input. Le risposte non si copiano: si leggono dalle run.
// Log: solo id e conteggi, mai testi.

import {
  db,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  leadConversationsTable,
  leadMessagesTable,
  pendingActionsTable,
  runStepsTable,
  runsTable,
  usersTable,
  type LeadConversation,
  type Run,
} from "@workspace/db";
import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { runBudgetBlock } from "../budget";
import { DEFAULT_LEAD_APP_SLUG } from "../product-leads";
import { createQueuedRun, scheduleRuns } from "../run-queue";
import { describeRunStep } from "../turn-progress/describe";
import { PROGRESS_MAX_STEPS, type TurnProgressView } from "../turn-progress/progress";
import { consumeLeadChatMessage } from "../../middlewares/rate-limit";
import { LEAD_CHAT_LIMITS, leadChatRunInput, parseLeadPage, type LeadExchange, type LeadPage } from "./input";
import { LEAD_CHAT_MESSAGES, LeadChatError } from "./messages";

export const LEAD_CONVERSATIONS_MAX = 100;
const TITLE_MAX = 80;
const ITEMS_PER_RUN = 10;
const OPEN_STATUSES = new Set(["pending", "running"]);

export type LeadChatAvailability =
  | { available: true; agentId: number; agentName: string; appName: string; aiModelId: number; modelName: string }
  | { available: false; reason: string; agentId: number | null };

export type LeadQueueItem = { number: number; kind: string; status: string; summary: string };

export type LeadRunView = {
  id: number;
  status: string;
  output: string | null;
  error: string | null;
  costUsd: number | null;
  items: LeadQueueItem[];
};

export type LeadMessageView = {
  id: number;
  content: string;
  pageContext: LeadPage | null;
  createdAt: Date;
  run: LeadRunView | null;
};

export type LeadConversationSummary = { id: number; title: string; updatedAt: Date; tokensUsed: number; costUsd: number | null };

export type LeadConversationDetail = {
  id: number;
  title: string;
  agentId: number;
  aiModelId: number | null;
  createdAt: Date;
  updatedAt: Date;
  turnStatus: "idle" | "running";
  tokensUsed: number;
  costUsd: number | null;
  messages: LeadMessageView[];
  progress: TurnProgressView | null;
};

// --- Disponibilità -------------------------------------------------------------------------------

async function userOwnsModel(userId: number, aiModelId: number): Promise<{ name: string } | null> {
  const [row] = await db
    .select({ displayName: aiModelsTable.displayName, modelId: aiModelsTable.modelId })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiAccountsTable.id, aiModelsTable.accountId))
    .where(and(eq(aiModelsTable.id, aiModelId), eq(aiAccountsTable.userId, userId)))
    .limit(1);
  return row ? { name: row.displayName ?? row.modelId } : null;
}

/** Il Responsabile di Botcave è usabile dall'utente? App `casello` attiva, `general` attivo, modello di un suo account. */
export async function resolveLeadChat(userId: number): Promise<LeadChatAvailability> {
  const [app] = await db.select().from(appsTable).where(eq(appsTable.slug, DEFAULT_LEAD_APP_SLUG)).limit(1);
  if (!app || app.status !== "active") return { available: false, reason: LEAD_CHAT_MESSAGES.noApp, agentId: null };
  const [lead] = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.appId, app.id), eq(agentsTable.role, "general")))
    .orderBy(asc(agentsTable.id))
    .limit(1);
  if (!lead || lead.status !== "active") return { available: false, reason: LEAD_CHAT_MESSAGES.inactive, agentId: lead?.id ?? null };
  const model = lead.aiModelId === null ? null : await userOwnsModel(userId, lead.aiModelId);
  if (!model || lead.aiModelId === null) return { available: false, reason: LEAD_CHAT_MESSAGES.noModel, agentId: lead.id };
  return { available: true, agentId: lead.id, agentName: lead.name, appName: app.name, aiModelId: lead.aiModelId, modelName: model.name };
}

async function requireAvailable(userId: number): Promise<Extract<LeadChatAvailability, { available: true }>> {
  const a = await resolveLeadChat(userId);
  if (!a.available) throw new LeadChatError(409, a.reason);
  return a;
}

// --- Conversazioni -------------------------------------------------------------------------------

async function ownedConversation(userId: number, id: number): Promise<LeadConversation> {
  const [conv] = await db
    .select()
    .from(leadConversationsTable)
    .where(and(eq(leadConversationsTable.id, id), eq(leadConversationsTable.userId, userId)))
    .limit(1);
  if (!conv) throw new LeadChatError(404, LEAD_CHAT_MESSAGES.notFound);
  return conv;
}

export async function createLeadConversation(userId: number): Promise<LeadConversation> {
  const a = await requireAvailable(userId);
  const [row] = await db
    .select({ n: count() })
    .from(leadConversationsTable)
    .where(and(eq(leadConversationsTable.userId, userId), isNull(leadConversationsTable.archivedAt)));
  if (Number(row?.n ?? 0) >= LEAD_CONVERSATIONS_MAX) throw new LeadChatError(409, LEAD_CHAT_MESSAGES.tooManyConversations);
  const [conv] = await db.insert(leadConversationsTable).values({ userId, agentId: a.agentId }).returning();
  return conv!;
}

export async function deleteLeadConversation(userId: number, id: number): Promise<void> {
  await ownedConversation(userId, id);
  await db.delete(leadConversationsTable).where(eq(leadConversationsTable.id, id));
}

type Totals = { tokensUsed: number; costUsd: number | null };

/** Token e costo sommati sulle run; costo null se una run che ha usato token non ha prezzo. */
function totals(runs: Run[]): Totals {
  let tokensUsed = 0;
  let cost = 0;
  let partial = false;
  for (const r of runs) {
    const tokens = (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
    tokensUsed += tokens;
    if (r.costUsd !== null) cost += Number(r.costUsd);
    else if (tokens > 0) partial = true;
  }
  return { tokensUsed, costUsd: partial ? null : cost };
}

async function runsOf(conversationIds: number[]): Promise<{ conversationId: number; run: Run }[]> {
  if (conversationIds.length === 0) return [];
  return db
    .select({ conversationId: leadMessagesTable.conversationId, run: runsTable })
    .from(leadMessagesTable)
    .innerJoin(runsTable, eq(runsTable.id, leadMessagesTable.runId))
    .where(inArray(leadMessagesTable.conversationId, conversationIds));
}

export async function listLeadConversations(userId: number): Promise<LeadConversationSummary[]> {
  const convs = await db
    .select()
    .from(leadConversationsTable)
    .where(and(eq(leadConversationsTable.userId, userId), isNull(leadConversationsTable.archivedAt)))
    .orderBy(desc(leadConversationsTable.updatedAt), desc(leadConversationsTable.id))
    .limit(LEAD_CONVERSATIONS_MAX);
  const byConv = new Map<number, Run[]>();
  for (const { conversationId, run } of await runsOf(convs.map((c) => c.id))) {
    byConv.set(conversationId, [...(byConv.get(conversationId) ?? []), run]);
  }
  return convs.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, ...totals(byConv.get(c.id) ?? []) }));
}

// --- Messaggi ------------------------------------------------------------------------------------

function replyOf(run: Run | undefined): string {
  if (!run || OPEN_STATUSES.has(run.status)) return "(nessuna risposta)";
  if (run.status === "succeeded") return run.output?.trim() ? run.output : "(nessuna risposta)";
  if (run.status === "failed") return `(errore: ${run.errorMessage ?? "run non riuscita"})`;
  return "(nessuna risposta)";
}

export async function sendLeadMessage(
  userId: number,
  conversationId: number,
  input: { content: string; pageContext?: unknown },
): Promise<{ messageId: number; runId: number }> {
  const conv = await ownedConversation(userId, conversationId);
  if (conv.archivedAt !== null) throw new LeadChatError(409, LEAD_CHAT_MESSAGES.archived);
  const content = input.content.trim();
  if (content === "") throw new LeadChatError(400, LEAD_CHAT_MESSAGES.empty);
  if (input.content.length > LEAD_CHAT_LIMITS.messageMax) throw new LeadChatError(400, LEAD_CHAT_MESSAGES.tooLong);
  const page = parseLeadPage(input.pageContext);
  if (page === "invalid") throw new LeadChatError(400, LEAD_CHAT_MESSAGES.badPage);

  const a = await requireAvailable(userId);
  if (a.agentId !== conv.agentId) throw new LeadChatError(409, LEAD_CHAT_MESSAGES.changed);

  const previous = await db
    .select({ message: leadMessagesTable, run: runsTable })
    .from(leadMessagesTable)
    .leftJoin(runsTable, eq(runsTable.id, leadMessagesTable.runId))
    .where(eq(leadMessagesTable.conversationId, conv.id))
    .orderBy(desc(leadMessagesTable.id))
    .limit(LEAD_CHAT_LIMITS.historyTurns);
  const last = previous[0];
  if (last?.run && OPEN_STATUSES.has(last.run.status)) throw new LeadChatError(409, LEAD_CHAT_MESSAGES.busy);

  if (!consumeLeadChatMessage(userId)) throw new LeadChatError(429, LEAD_CHAT_MESSAGES.tooMany);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, a.agentId)).limit(1);
  if (!agent) throw new LeadChatError(409, LEAD_CHAT_MESSAGES.inactive);
  const blocked = await runBudgetBlock(agent);
  if (blocked) throw new LeadChatError(409, blocked);

  const [user] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const history: LeadExchange[] = previous
    .slice()
    .reverse()
    .map((p) => ({ message: p.message.content, reply: replyOf(p.run ?? undefined) }));
  const runInput = leadChatRunInput({ userName: user?.name ?? null, page, history, message: content });

  const result = await db.transaction(async (tx) => {
    // Un messaggio alla volta anche con due invii simultanei: riga della conversazione bloccata, stato dell'ultima run riletto
    const [locked] = await tx.select().from(leadConversationsTable).where(eq(leadConversationsTable.id, conv.id)).for("update");
    if (!locked) throw new LeadChatError(404, LEAD_CHAT_MESSAGES.notFound);
    const [lastNow] = await tx
      .select({ status: runsTable.status })
      .from(leadMessagesTable)
      .leftJoin(runsTable, eq(runsTable.id, leadMessagesTable.runId))
      .where(eq(leadMessagesTable.conversationId, conv.id))
      .orderBy(desc(leadMessagesTable.id))
      .limit(1);
    if (lastNow?.status && OPEN_STATUSES.has(lastNow.status)) throw new LeadChatError(409, LEAD_CHAT_MESSAGES.busy);
    const created = await createQueuedRun({ agent, input: runInput, tx });
    if (!created.ok) return null;
    const [message] = await tx
      .insert(leadMessagesTable)
      .values({ conversationId: conv.id, content, pageContext: page, runId: created.run.id })
      .returning();
    const title = locked.title === "" ? (content.split("\n")[0] ?? "").trim().slice(0, TITLE_MAX) : locked.title;
    await tx.update(leadConversationsTable).set({ title, updatedAt: new Date() }).where(eq(leadConversationsTable.id, conv.id));
    return { messageId: message!.id, runId: created.run.id };
  });
  if (!result) throw new LeadChatError(429, LEAD_CHAT_MESSAGES.queueFull);
  void scheduleRuns();
  return result;
}

// --- Dettaglio -----------------------------------------------------------------------------------

async function queueItemsByRun(runIds: number[]): Promise<Map<number, LeadQueueItem[]>> {
  const out = new Map<number, LeadQueueItem[]>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select()
    .from(pendingActionsTable)
    .where(inArray(pendingActionsTable.runId, runIds))
    .orderBy(asc(pendingActionsTable.number));
  for (const r of rows) {
    const list = out.get(r.runId!) ?? [];
    if (list.length < ITEMS_PER_RUN) list.push({ number: r.number, kind: r.kind, status: r.status, summary: r.summary });
    out.set(r.runId!, list);
  }
  return out;
}

async function runProgress(run: Run): Promise<TurnProgressView> {
  const steps = await db
    .select({ type: runStepsTable.type, toolName: runStepsTable.toolName })
    .from(runStepsTable)
    .where(eq(runStepsTable.runId, run.id))
    .orderBy(asc(runStepsTable.position), asc(runStepsTable.id));
  const shown = steps.slice(-PROGRESS_MAX_STEPS);
  return {
    // Le run non registrano l'avvio: vale la creazione (comprende l'attesa in coda)
    startedAt: run.createdAt.toISOString(),
    steps: shown.map((s, i) => ({ text: describeRunStep(s), status: i === shown.length - 1 ? "running" : "done" })),
    omitted: steps.length - shown.length,
  };
}

const toPage = (value: unknown): LeadPage | null => {
  const p = parseLeadPage(value);
  return p === "invalid" ? null : p;
};

export async function getLeadConversation(userId: number, id: number): Promise<LeadConversationDetail> {
  const conv = await ownedConversation(userId, id);
  const rows = await db
    .select({ message: leadMessagesTable, run: runsTable })
    .from(leadMessagesTable)
    .leftJoin(runsTable, eq(runsTable.id, leadMessagesTable.runId))
    .where(eq(leadMessagesTable.conversationId, conv.id))
    .orderBy(asc(leadMessagesTable.id));
  const runs = rows.flatMap((r) => (r.run ? [r.run] : []));
  const items = await queueItemsByRun(runs.map((r) => r.id));
  const [agent] = await db.select({ aiModelId: agentsTable.aiModelId }).from(agentsTable).where(eq(agentsTable.id, conv.agentId));

  const lastRun = rows.at(-1)?.run ?? null;
  const running = lastRun !== null && OPEN_STATUSES.has(lastRun.status);
  return {
    id: conv.id,
    title: conv.title,
    agentId: conv.agentId,
    aiModelId: agent?.aiModelId ?? null,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    turnStatus: running ? "running" : "idle",
    ...totals(runs),
    messages: rows.map(({ message, run }) => ({
      id: message.id,
      content: message.content,
      pageContext: toPage(message.pageContext),
      createdAt: message.createdAt,
      run: run
        ? {
            id: run.id,
            status: run.status,
            output: run.output,
            error: run.errorMessage,
            costUsd: run.costUsd === null ? null : Number(run.costUsd),
            items: items.get(run.id) ?? [],
          }
        : null,
    })),
    progress: running && lastRun ? await runProgress(lastRun) : null,
  };
}

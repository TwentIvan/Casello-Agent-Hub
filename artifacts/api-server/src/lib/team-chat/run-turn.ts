// Esecuzione dei turni della chat di Lucius sulla squadra: stesso ciclo della chat del piano (`runChatTurn`) con gli
// strumenti della squadra. `startTeamChatTurn` risponde subito con il messaggio dell'utente e lancia il turno in
// background. Nei log solo id e conteggi: mai il contenuto dei messaggi.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  teamChatConversationsTable,
  teamChatMessagesTable,
  teamChatProposalsTable,
  teamInstancesTable,
  type TeamChatMessage,
} from "@workspace/db";
import { logger } from "../logger";
import { ProviderError } from "../ai/discovery";
import { ModelAccessError, resolveModel } from "../ai/executor";
import { sliceChars } from "../architect/text";
import { characterBudgetBlock } from "../budget";
import { memoryContextBlock } from "../memory/context";
import { EMPTY_REPLY_MESSAGE, INTERRUPTED_TURN_MESSAGE, TurnBusyError } from "../plan-chat/run-turn";
import { runChatTurn } from "../node-turns/chat-turn";
import { InstanceError, INSTANCE_MESSAGES } from "../teams/instances";
import { buildTeamChatMessages, type HistoryMessage } from "./context";
import { currentValueHash } from "./decide";
import { loadTeamSnapshot } from "./snapshot";
import { TEAM_CHAT_TOOLS, TeamChatToolRunner } from "./tools";

export { TurnBusyError };

export const TEAM_CHAT_MESSAGE_MAX_CHARS = 8_000;
const NO_MODEL_MESSAGE = "Scegli un modello per la conversazione.";
const GENERIC_ERROR_MESSAGE = "Errore nel turno della conversazione.";
const TITLE_MAX_CHARS = 80;

/**
 * Salva il messaggio dell'utente e avvia il turno in background. Un solo turno alla volta per conversazione
 * (`TurnBusyError`); squadra chiusa → `InstanceError` 409 «squadra chiusa».
 */
export async function startTeamChatTurn(conversationId: number, content: string): Promise<TeamChatMessage> {
  const [found] = await db
    .select({ status: teamInstancesTable.status })
    .from(teamChatConversationsTable)
    .innerJoin(teamInstancesTable, eq(teamInstancesTable.id, teamChatConversationsTable.teamInstanceId))
    .where(eq(teamChatConversationsTable.id, conversationId));
  if (!found) throw new InstanceError(404, INSTANCE_MESSAGES.notFound);
  if (found.status === "closed") throw new InstanceError(409, INSTANCE_MESSAGES.closed);

  const [conv] = await db
    .update(teamChatConversationsTable)
    .set({ turnStatus: "running", updatedAt: new Date() })
    .where(and(eq(teamChatConversationsTable.id, conversationId), eq(teamChatConversationsTable.turnStatus, "idle")))
    .returning();
  if (!conv) throw new TurnBusyError();

  try {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(teamChatMessagesTable)
      .where(eq(teamChatMessagesTable.conversationId, conversationId));
    const [userMessage] = await db.insert(teamChatMessagesTable).values({ conversationId, role: "user", content }).returning();
    if (n === 0) {
      const title = sliceChars(content.replace(/\s+/g, " ").trim(), TITLE_MAX_CHARS);
      await db.update(teamChatConversationsTable).set({ title }).where(eq(teamChatConversationsTable.id, conversationId));
    }
    const [assistant] = await db.insert(teamChatMessagesTable).values({ conversationId, role: "assistant", content: "" }).returning();
    void executeTeamChatTurn(conversationId, assistant!.id);
    return userMessage!;
  } catch (err) {
    // Il turno non è partito: la conversazione non deve restare bloccata
    await db
      .update(teamChatConversationsTable)
      .set({ turnStatus: "idle" })
      .where(eq(teamChatConversationsTable.id, conversationId))
      .catch(() => {});
    throw err;
  }
}

/** Cronologia senza il messaggio vuoto del turno in corso; l'ultimo messaggio dell'utente a parte. */
async function loadHistory(conversationId: number, assistantMessageId: number): Promise<{ history: HistoryMessage[]; userMessage: string }> {
  const messages = await db
    .select()
    .from(teamChatMessagesTable)
    .where(eq(teamChatMessagesTable.conversationId, conversationId))
    .orderBy(asc(teamChatMessagesTable.id));
  const proposals = await db
    .select()
    .from(teamChatProposalsTable)
    .where(eq(teamChatProposalsTable.conversationId, conversationId))
    .orderBy(asc(teamChatProposalsTable.id));
  const history: HistoryMessage[] = messages
    .filter((m) => m.id < assistantMessageId && !(m.role === "assistant" && m.content === ""))
    .map((m) => ({
      role: m.role,
      content: m.content,
      proposals: proposals.filter((p) => p.messageId === m.id).map((p) => ({ kind: p.kind, roleKey: p.roleKey, status: p.status })),
    }));
  const last = history.at(-1);
  if (last?.role !== "user") throw new Error("messaggio dell'utente mancante");
  history.pop();
  return { history, userMessage: last.content };
}

function errorText(err: unknown): string {
  if (err instanceof ProviderError || err instanceof ModelAccessError) return err.message;
  return GENERIC_ERROR_MESSAGE;
}

/** Esegue il turno e lo chiude sempre (messaggio dell'assistente, schede, totali, `idle`). Non lancia mai. */
export async function executeTeamChatTurn(conversationId: number, assistantMessageId: number): Promise<void> {
  let content = GENERIC_ERROR_MESSAGE;
  let isError = true;
  let tokens = 0;
  let costUsd: string | null = null;
  let proposals: Array<typeof teamChatProposalsTable.$inferInsert> = [];
  try {
    const [conv] = await db.select().from(teamChatConversationsTable).where(eq(teamChatConversationsTable.id, conversationId));
    if (!conv) return;
    const blocked = conv.aiModelId === null ? null : await characterBudgetBlock(conv.userId, "lucius", conv.aiModelId);
    if (conv.aiModelId === null) {
      content = NO_MODEL_MESSAGE;
    } else if (blocked) {
      content = blocked;
    } else {
      const team = await loadTeamSnapshot(conv.teamInstanceId);
      const { history, userMessage } = await loadHistory(conversationId, assistantMessageId);
      const messages = buildTeamChatMessages({ team, memory: await memoryContextBlock(conv.userId, "lucius"), history, userMessage });
      const resolved = await resolveModel(conv.aiModelId, { userId: conv.userId, mustOwn: true });
      const runner = new TeamChatToolRunner(conv.teamInstanceId, conv.userId, team);
      try {
        const outcome = await runChatTurn({
          resolved,
          userId: conv.userId,
          consumer: "team_chat",
          refId: conversationId,
          messageId: assistantMessageId,
          messages,
          tools: [...TEAM_CHAT_TOOLS],
          runTool: (call) => runner.run(call),
          caller: "team-chat",
          budgetCheck: (aiModelId) => characterBudgetBlock(conv.userId, "lucius", aiModelId),
        });
        tokens = outcome.tokens;
        costUsd = outcome.costUsd;
        if (outcome.ok) {
          content = outcome.content.trim() === "" ? EMPTY_REPLY_MESSAGE : outcome.content;
          isError = false;
        } else {
          content = outcome.error;
        }
      } finally {
        // Lo hash è quello della squadra letta all'inizio del turno: una modifica nel frattempo rende la scheda `stale`
        proposals = runner.proposals.map((p) => ({
          conversationId,
          messageId: assistantMessageId,
          kind: p.kind,
          roleKey: p.roleKey,
          payload: p.payload,
          rationale: p.rationale,
          targetHash: currentValueHash(team, p.kind, p.roleKey),
        }));
      }
    }
  } catch (err) {
    content = errorText(err);
    logger.warn({ conversationId, errName: err instanceof Error ? err.name : typeof err }, "Turno della chat di squadra non riuscito");
  }

  try {
    await db.transaction(async (tx) => {
      await tx.update(teamChatMessagesTable).set({ content, error: isError, tokens }).where(eq(teamChatMessagesTable.id, assistantMessageId));
      if (proposals.length > 0) await tx.insert(teamChatProposalsTable).values(proposals);
      // Costo parziale (null) se manca il prezzo di un turno con token; una conversazione senza token parte da 0
      await tx
        .update(teamChatConversationsTable)
        .set({
          tokensUsed: sql`${teamChatConversationsTable.tokensUsed} + ${tokens}`,
          costUsd:
            tokens === 0
              ? sql`${teamChatConversationsTable.costUsd}`
              : costUsd === null
                ? sql`null`
                : sql`case when ${teamChatConversationsTable.tokensUsed} = 0 then 0 else ${teamChatConversationsTable.costUsd} end + ${costUsd}::numeric`,
          turnStatus: "idle",
          updatedAt: new Date(),
        })
        .where(eq(teamChatConversationsTable.id, conversationId));
    });
  } catch (err) {
    logger.error({ conversationId, errName: err instanceof Error ? err.name : typeof err }, "Chiusura del turno della chat di squadra non riuscita");
    await db
      .update(teamChatConversationsTable)
      .set({ turnStatus: "idle" })
      .where(eq(teamChatConversationsTable.id, conversationId))
      .catch(() => {});
  }
  logger.info({ conversationId, assistantMessageId, tokens, proposals: proposals.length, error: isError }, "Turno della chat di squadra chiuso");
}

/** All'avvio i turni rimasti `running` sono stati interrotti dal riavvio: si chiudono con un messaggio. */
export async function failInterruptedTeamChatTurns(): Promise<number> {
  return db.transaction(async (tx) => {
    const interrupted = await tx
      .update(teamChatConversationsTable)
      .set({ turnStatus: "idle", updatedAt: new Date() })
      .where(eq(teamChatConversationsTable.turnStatus, "running"))
      .returning({ id: teamChatConversationsTable.id });
    if (interrupted.length === 0) return 0;
    const ids = interrupted.map((c) => c.id);
    const lastEmpties = await tx
      .select({ id: sql<number>`max(${teamChatMessagesTable.id})::int` })
      .from(teamChatMessagesTable)
      .where(and(inArray(teamChatMessagesTable.conversationId, ids), eq(teamChatMessagesTable.role, "assistant"), eq(teamChatMessagesTable.content, "")))
      .groupBy(teamChatMessagesTable.conversationId);
    const empties =
      lastEmpties.length === 0
        ? []
        : await tx
            .update(teamChatMessagesTable)
            .set({ content: INTERRUPTED_TURN_MESSAGE, error: true })
            .where(inArray(teamChatMessagesTable.id, lastEmpties.map((m) => m.id)))
            .returning({ conversationId: teamChatMessagesTable.conversationId });
    const covered = new Set(empties.map((m) => m.conversationId));
    const missing = ids.filter((id) => !covered.has(id));
    if (missing.length > 0) {
      await tx
        .insert(teamChatMessagesTable)
        .values(missing.map((conversationId) => ({ conversationId, role: "assistant" as const, content: INTERRUPTED_TURN_MESSAGE, error: true })));
    }
    return interrupted.length;
  });
}

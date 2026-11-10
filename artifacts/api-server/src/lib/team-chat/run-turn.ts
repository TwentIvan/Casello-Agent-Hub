// Esecuzione dei turni della chat di Lucius sulla squadra: stesso ciclo della chat del piano (`runChatTurn`) con gli
// strumenti della squadra. `startTeamChatTurn` risponde subito con il messaggio dell'utente e lancia il turno in
// background. Nei log solo id e conteggi: mai il contenuto dei messaggi.

import { and, asc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import {
  db,
  teamChatConversationsTable,
  teamChatMessagesTable,
  teamChatProposalsTable,
  appsTable,
  teamInstancesTable,
  type TeamChatMessage,
} from "@workspace/db";
import { logger } from "../logger";
import { trackTurn, type StaleTurnFilter } from "../stale-turns";
import { ProviderError } from "../ai/discovery";
import { ModelAccessError, resolveModel } from "../ai/executor";
import { sliceChars } from "../architect/text";
import { characterBudgetBlock } from "../budget";
import { memoryContextBlock } from "../memory/context";
import { EMPTY_REPLY_MESSAGE, INTERRUPTED_TURN_MESSAGE, TurnBusyError } from "../plan-chat/run-turn";
import { runChatTurn } from "../node-turns/chat-turn";
import { codeAvailability } from "../code-reader/source-cache";
import { CODE_INSTRUCTIONS_GENERAL, CODE_TOOLS, CodeToolRunner, isCodeTool } from "../code-reader/tools";
import { CODE_TURN_LIMITS, STOPPED_TURN_MESSAGE } from "../plan-chat/turn";
import { drainQueued, isTurnOpen } from "../chat-turns/control";
import { turnTotals } from "../chat-turns/totals";
import type { ChatKindSpec } from "../chat-turns/spec";
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
      .where(and(eq(teamChatMessagesTable.conversationId, conversationId), isNull(teamChatMessagesTable.queuedAt)));
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
    // Il messaggio in coda non è ancora partito: fuori dalla cronologia
    .where(and(eq(teamChatMessagesTable.conversationId, conversationId), isNull(teamChatMessagesTable.queuedAt)))
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

/** La chat di squadra per «Ferma» e «Accoda» (`lib/chat-turns/control.ts`); la pagina non serve. */
export const TEAM_CHAT_SPEC: ChatKindSpec = {
  kind: "team",
  consumer: "team_chat",
  conversationsTable: "team_chat_conversations",
  messagesTable: "team_chat_messages",
  hasPageContext: false,
  start: (conversationId, content) => startTeamChatTurn(conversationId, content),
};

/**
 * Esegue il turno e lo chiude sempre (messaggio dell'assistente, schede, totali, `idle`), poi fa partire il messaggio
 * in coda. «Ferma» interrompe il turno con il segnale: risposta «Risposta interrotta.». Non lancia mai.
 */
export function executeTeamChatTurn(conversationId: number, assistantMessageId: number): Promise<void> {
  return trackTurn("team", conversationId, (signal) => executeTeamChatTurnInner(conversationId, assistantMessageId, signal), assistantMessageId)
    .catch((err: unknown) => {
      logger.error({ conversationId, errName: err instanceof Error ? err.name : typeof err }, "Turno della chat di squadra non chiuso");
    })
    .then(() => drainQueued(TEAM_CHAT_SPEC, conversationId));
}

async function executeTeamChatTurnInner(conversationId: number, assistantMessageId: number, signal: AbortSignal): Promise<void> {
  // Turno chiuso nel DB prima di partire davvero (Ferma da un altro processo): niente modello. Se «Ferma» è arrivato
  // prima che il messaggio dell'assistente fosse scritto, quel messaggio è rimasto vuoto: diventa «Risposta interrotta.»
  if (!(await isTurnOpen(TEAM_CHAT_SPEC, conversationId, assistantMessageId))) {
    await db
      .update(teamChatMessagesTable)
      .set({ content: STOPPED_TURN_MESSAGE, error: false })
      .where(and(eq(teamChatMessagesTable.id, assistantMessageId), eq(teamChatMessagesTable.content, "")));
    return;
  }
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
      // Codice dell'app di riferimento della squadra (un solo lettore per turno)
      const [refApp] = await db
        .select({ app: appsTable })
        .from(teamInstancesTable)
        .innerJoin(appsTable, eq(appsTable.id, teamInstancesTable.refAppId))
        .where(eq(teamInstancesTable.id, conv.teamInstanceId))
        .limit(1);
      const codeRunner = refApp && (await codeAvailability(conv.userId, refApp.app)).ok ? new CodeToolRunner(conv.userId, refApp.app.id) : null;
      const messages = buildTeamChatMessages({
        team,
        memory: await memoryContextBlock(conv.userId, "lucius"),
        history,
        userMessage,
        ...(codeRunner ? { codeInstructions: CODE_INSTRUCTIONS_GENERAL } : {}),
      });
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
          tools: codeRunner ? [...TEAM_CHAT_TOOLS, ...CODE_TOOLS] : [...TEAM_CHAT_TOOLS],
          ...(codeRunner ? { limits: CODE_TURN_LIMITS } : {}),
          runTool: (call) => (codeRunner && isCodeTool(call.name) ? codeRunner.run(call) : runner.run(call)),
          caller: "team-chat",
          budgetCheck: (aiModelId) => characterBudgetBlock(conv.userId, "lucius", aiModelId),
          signal,
        });
        tokens = outcome.tokens;
        costUsd = outcome.costUsd;
        // Un esito arrivato subito dopo «Ferma» (es. dal nodo) vale come interruzione
        if ((!outcome.ok && outcome.stopped === true) || signal.aborted) {
          content = STOPPED_TURN_MESSAGE;
          isError = false;
        } else if (outcome.ok) {
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
    if (signal.aborted) {
      content = STOPPED_TURN_MESSAGE;
      isError = false;
    } else {
      content = errorText(err);
      logger.warn({ conversationId, errName: err instanceof Error ? err.name : typeof err }, "Turno della chat di squadra non riuscito");
    }
  }

  try {
    await db.transaction(async (tx) => {
      // Le schede proposte restano anche se il turno è stato fermato o chiuso altrove (come nelle altre chat)
      if (proposals.length > 0) await tx.insert(teamChatProposalsTable).values(proposals);
      // Solo se il messaggio è ancora vuoto: altrimenti il turno è stato chiuso altrove (si sommano solo i totali)
      const written = await tx
        .update(teamChatMessagesTable)
        .set({ content, error: isError, tokens })
        .where(and(eq(teamChatMessagesTable.id, assistantMessageId), eq(teamChatMessagesTable.content, "")))
        .returning({ id: teamChatMessagesTable.id });
      const totals = turnTotals(teamChatConversationsTable.tokensUsed, teamChatConversationsTable.costUsd, tokens, costUsd);
      if (written.length === 0) {
        // Turno chiuso altrove: chi l'ha chiuso non somma i totali, quindi i token spesi si sommano qui; stato e
        // updated_at restano quelli della chiusura
        if (tokens > 0) await tx.update(teamChatConversationsTable).set(totals).where(eq(teamChatConversationsTable.id, conversationId));
        return;
      }
      await tx
        .update(teamChatConversationsTable)
        .set({
          ...totals,
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
  logger.info({ conversationId, assistantMessageId, tokens, proposals: proposals.length, error: isError, stopped: signal.aborted }, "Turno della chat di squadra chiuso");
}

/** All'avvio i turni rimasti `running` sono stati interrotti dal riavvio: si chiudono con un messaggio. */
export async function failInterruptedTeamChatTurns(filter?: StaleTurnFilter): Promise<number> {
  const ids = await closeInterruptedTeamChatTurns(filter);
  // Le conversazioni chiuse possono avere un messaggio in coda: parte ora
  for (const id of ids) await drainQueued(TEAM_CHAT_SPEC, id);
  return ids.length;
}

async function closeInterruptedTeamChatTurns(filter?: StaleTurnFilter): Promise<number[]> {
  return db.transaction(async (tx) => {
    const interrupted = await tx
      .update(teamChatConversationsTable)
      .set({ turnStatus: "idle", updatedAt: new Date() })
      .where(
        and(
          eq(teamChatConversationsTable.turnStatus, "running"),
          filter ? lt(teamChatConversationsTable.updatedAt, filter.olderThan) : undefined,
          filter && filter.exclude.length > 0 ? notInArray(teamChatConversationsTable.id, filter.exclude) : undefined,
        ),
      )
      .returning({ id: teamChatConversationsTable.id });
    if (interrupted.length === 0) return [];
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
    return ids;
  });
}

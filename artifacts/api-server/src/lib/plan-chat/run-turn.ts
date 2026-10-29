// Esecuzione dei turni della chat del piano: collega il ciclo puro (`turn.ts`) al DB e al modello.
// `startPlanTurn` risponde subito con il messaggio dell'utente e lancia il turno in background.
// Nei log solo id e conteggi: mai il contenuto dei messaggi.

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  analysesTable,
  analysisItemsTable,
  appToolsTable,
  appsTable,
  planConversationsTable,
  planMessagesTable,
  planProposalsTable,
  type AnalysisItem,
  type PlanMessage,
} from "@workspace/db";
import { logger } from "../logger";
import { ProviderError } from "../ai/discovery";
import { ModelAccessError, modelChat, resolveModel } from "../ai/executor";
import { sliceChars } from "../architect/text";
import {
  PLAN_CHAPTERS,
  buildPlanMessages,
  itemTitle,
  type HistoryMessage,
  type HistoryProposal,
  type OtherAppCard,
  type PlanChapter,
  type PlanItemRow,
} from "./context";
import { itemHash } from "./decide";
import { PlanToolRunner, type PlanToolItem } from "./tools";
import { runPlanTurn } from "./turn";

export const PLAN_MESSAGE_MAX_CHARS = 8_000;
export const INTERRUPTED_TURN_MESSAGE = "Turno interrotto dal riavvio di Casello: riscrivi il messaggio.";
const NO_MODEL_MESSAGE = "Scegli un modello per la conversazione.";
export const EMPTY_REPLY_MESSAGE = "(nessuna risposta testuale)";
const GENERIC_ERROR_MESSAGE = "Errore nel turno della conversazione.";
const APP_CARD_MAP_MAX_CHARS = 4_000;
const TITLE_MAX_CHARS = 80;

export class TurnBusyError extends Error {
  constructor() {
    super("Un turno della conversazione è già in corso");
    this.name = "TurnBusyError";
  }
}

/**
 * Voci del piano: i capitoli endpoint/completion/evolution dell'analisi della conversazione, più le voci
 * nate in chat e approvate delle analisi precedenti della stessa app.
 */
export async function loadPlanItems(analysisId: number, appId: number): Promise<AnalysisItem[]> {
  const chapters = PLAN_CHAPTERS as string[];
  const current = await db
    .select()
    .from(analysisItemsTable)
    .where(and(eq(analysisItemsTable.analysisId, analysisId), inArray(analysisItemsTable.chapter, chapters as never[])))
    .orderBy(asc(analysisItemsTable.position), asc(analysisItemsTable.id));
  const earlier = await db
    .select({ item: analysisItemsTable })
    .from(analysisItemsTable)
    .innerJoin(analysesTable, eq(analysesTable.id, analysisItemsTable.analysisId))
    .where(
      and(
        eq(analysesTable.appId, appId),
        ne(analysisItemsTable.analysisId, analysisId),
        eq(analysisItemsTable.origin, "chat"),
        eq(analysisItemsTable.status, "approved"),
        inArray(analysisItemsTable.chapter, chapters as never[]),
      ),
    )
    .orderBy(asc(analysisItemsTable.id));
  return [...current, ...earlier.map((r) => r.item)];
}

/** Salva il messaggio dell'utente e avvia il turno in background. Un solo turno alla volta per conversazione. */
export async function startPlanTurn(conversationId: number, content: string): Promise<PlanMessage> {
  const [conv] = await db
    .update(planConversationsTable)
    .set({ turnStatus: "running", updatedAt: new Date() })
    .where(and(eq(planConversationsTable.id, conversationId), eq(planConversationsTable.turnStatus, "idle")))
    .returning();
  if (!conv) throw new TurnBusyError();

  try {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(planMessagesTable)
      .where(eq(planMessagesTable.conversationId, conversationId));
    const [userMessage] = await db
      .insert(planMessagesTable)
      .values({ conversationId, role: "user", content })
      .returning();
    if (n === 0) {
      const title = sliceChars(content.replace(/\s+/g, " ").trim(), TITLE_MAX_CHARS);
      await db.update(planConversationsTable).set({ title }).where(eq(planConversationsTable.id, conversationId));
    }
    const [assistant] = await db
      .insert(planMessagesTable)
      .values({ conversationId, role: "assistant", content: "" })
      .returning();
    void executePlanTurn(conversationId, assistant!.id);
    return userMessage!;
  } catch (err) {
    // Il turno non è partito: la conversazione non deve restare bloccata
    await db
      .update(planConversationsTable)
      .set({ turnStatus: "idle" })
      .where(eq(planConversationsTable.id, conversationId))
      .catch(() => {});
    throw err;
  }
}

function toRow(i: AnalysisItem): PlanItemRow {
  const p = (i.payload && typeof i.payload === "object" ? i.payload : {}) as Record<string, unknown>;
  return {
    ref: i.ref,
    chapter: i.chapter as PlanChapter,
    title: itemTitle(i.chapter as PlanChapter, i.payload),
    phase: typeof p.phase === "number" ? p.phase : null,
    dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn.filter((d): d is string => typeof d === "string") : [],
    effort: typeof p.effort === "string" ? p.effort : null,
    priority: typeof p.priority === "number" ? p.priority : null,
    status: i.status,
    origin: i.origin,
  };
}

async function activeToolNames(appId: number): Promise<string[]> {
  const rows = await db
    .select({ name: appToolsTable.name })
    .from(appToolsTable)
    .where(and(eq(appToolsTable.appId, appId), eq(appToolsTable.status, "active")))
    .orderBy(asc(appToolsTable.name));
  return rows.map((r) => r.name);
}

/** Scheda testuale di un'app per `read_app`: mai indirizzi né segreti. */
async function readAppCard(slug: string): Promise<string | null> {
  const [app] = await db.select().from(appsTable).where(eq(appsTable.slug, slug));
  if (!app) return null;
  const tools = await activeToolNames(app.id);
  const [analysis] = await db
    .select({ map: analysesTable.architectureMap })
    .from(analysesTable)
    .where(and(eq(analysesTable.appId, app.id), sql`${analysesTable.architectureMap} is not null`))
    .orderBy(desc(analysesTable.id))
    .limit(1);
  return [
    `App: ${app.name} (${app.slug})`,
    `Descrizione: ${app.functionalDescription ?? app.description ?? "nessuna"}`,
    `Strumenti attivi: ${tools.length > 0 ? tools.join(", ") : "nessuno"}`,
    `Mappa: ${sliceChars(JSON.stringify(analysis?.map ?? null), APP_CARD_MAP_MAX_CHARS)}`,
  ].join("\n");
}

async function loadHistory(conversationId: number, assistantMessageId: number): Promise<HistoryMessage[]> {
  const messages = await db
    .select()
    .from(planMessagesTable)
    .where(eq(planMessagesTable.conversationId, conversationId))
    .orderBy(asc(planMessagesTable.id));
  const proposals = await db
    .select()
    .from(planProposalsTable)
    .where(eq(planProposalsTable.conversationId, conversationId))
    .orderBy(asc(planProposalsTable.id));
  const targetIds = proposals.filter((p) => p.payload === null && p.targetItemId !== null).map((p) => p.targetItemId!);
  const targets = targetIds.length > 0 ? await db.select().from(analysisItemsTable).where(inArray(analysisItemsTable.id, targetIds)) : [];
  const targetById = new Map(targets.map((t) => [t.id, t]));

  const titleOf = (p: (typeof proposals)[number]): string => {
    if (p.payload !== null) return itemTitle(p.chapter as PlanChapter, p.payload);
    const t = p.targetItemId !== null ? targetById.get(p.targetItemId) : undefined;
    return t ? itemTitle(t.chapter as PlanChapter, t.payload) : "voce non più disponibile";
  };

  return messages
    // Fuori il messaggio vuoto del turno in corso (e ogni altro assistant vuoto): la cronologia finisce con l'utente
    .filter((m) => m.id !== assistantMessageId && !(m.role === "assistant" && m.content === ""))
    .map((m) => ({
      role: m.role,
      content: m.content,
      proposals: proposals
        .filter((p) => p.messageId === m.id)
        .map((p): HistoryProposal => ({ kind: p.kind, title: titleOf(p), status: p.status })),
    }));
}

function errorText(err: unknown): string {
  if (err instanceof ProviderError || err instanceof ModelAccessError) return err.message;
  return GENERIC_ERROR_MESSAGE;
}

/** Esegue il turno e lo chiude sempre (messaggio dell'assistente, totali, `idle`). Non lancia mai. */
export async function executePlanTurn(conversationId: number, assistantMessageId: number): Promise<void> {
  let content = GENERIC_ERROR_MESSAGE;
  let isError = true;
  let tokens = 0;
  let costUsd: string | null = null;
  try {
    const [conv] = await db.select().from(planConversationsTable).where(eq(planConversationsTable.id, conversationId));
    if (!conv) return;
    if (conv.aiModelId === null) {
      content = NO_MODEL_MESSAGE;
    } else {
      const [app] = await db.select().from(appsTable).where(eq(appsTable.id, conv.appId));
      const [analysis] = await db.select().from(analysesTable).where(eq(analysesTable.id, conv.analysisId));
      if (!app || !analysis) throw new Error("app o analisi non trovata");

      const items = await loadPlanItems(analysis.id, app.id);
      const toolItems = new Map<string, PlanToolItem>();
      for (const i of items) {
        // A parità di ref prevale la voce dell'analisi della conversazione (viene prima)
        if (!toolItems.has(i.ref)) {
          toolItems.set(i.ref, { id: i.id, ref: i.ref, chapter: i.chapter as PlanChapter, payload: i.payload, status: i.status, evidence: i.evidence });
        }
      }
      const others = await db.select().from(appsTable).where(ne(appsTable.id, app.id)).orderBy(asc(appsTable.id));
      const otherApps: OtherAppCard[] = [];
      for (const o of others) {
        otherApps.push({
          name: o.name,
          slug: o.slug,
          description: o.functionalDescription ?? o.description ?? null,
          toolNames: await activeToolNames(o.id),
        });
      }
      const messages = buildPlanMessages({
        app: {
          name: app.name,
          slug: app.slug,
          functionalDescription: app.functionalDescription ?? null,
          architectureMap: analysis.architectureMap,
          toolNames: await activeToolNames(app.id),
        },
        items: items.map(toRow),
        otherApps,
        history: await loadHistory(conversationId, assistantMessageId),
      });

      const resolved = await resolveModel(conv.aiModelId, { userId: conv.userId, mustOwn: true });
      const runner = new PlanToolRunner({
        items: toolItems,
        readApp: readAppCard,
        hash: itemHash,
        saveProposal: async (p) => {
          const [row] = await db
            .insert(planProposalsTable)
            .values({
              conversationId,
              messageId: assistantMessageId,
              kind: p.kind,
              chapter: p.chapter,
              payload: p.payload,
              rationale: p.rationale,
              targetItemId: p.targetItemId,
              targetHash: p.targetHash,
            })
            .returning({ id: planProposalsTable.id });
          return row!.id;
        },
      });
      const outcome = await runPlanTurn(messages, {
        chat: (msgs, tools, timeoutMs) => modelChat(resolved, { messages: msgs, tools, timeoutMs, caller: "plan-chat" }),
        runTool: (call) => runner.run(call),
        now: () => Date.now(),
      });
      tokens = outcome.tokens;
      costUsd = outcome.costUsd;
      if (outcome.ok) {
        content = outcome.content.trim() === "" ? EMPTY_REPLY_MESSAGE : outcome.content;
        isError = false;
      } else {
        content = outcome.error;
      }
    }
  } catch (err) {
    content = errorText(err);
    logger.warn({ conversationId, errName: err instanceof Error ? err.name : typeof err }, "Turno della chat del piano non riuscito");
  }

  try {
    await db.transaction(async (tx) => {
      await tx.update(planMessagesTable).set({ content, error: isError, tokens }).where(eq(planMessagesTable.id, assistantMessageId));
      // Costo parziale (null) se manca il prezzo di un turno con token; una conversazione senza token parte da 0
      await tx
        .update(planConversationsTable)
        .set({
          tokensUsed: sql`${planConversationsTable.tokensUsed} + ${tokens}`,
          costUsd:
            tokens === 0
              ? sql`${planConversationsTable.costUsd}`
              : costUsd === null
                ? sql`null`
                : sql`case when ${planConversationsTable.tokensUsed} = 0 then 0 else ${planConversationsTable.costUsd} end + ${costUsd}::numeric`,
          turnStatus: "idle",
          updatedAt: new Date(),
        })
        .where(eq(planConversationsTable.id, conversationId));
    });
  } catch (err) {
    logger.error({ conversationId, errName: err instanceof Error ? err.name : typeof err }, "Chiusura del turno della chat del piano non riuscita");
    // Ultimo tentativo: almeno sbloccare la conversazione
    await db
      .update(planConversationsTable)
      .set({ turnStatus: "idle" })
      .where(eq(planConversationsTable.id, conversationId))
      .catch(() => {});
  }
  logger.info({ conversationId, assistantMessageId, tokens, error: isError }, "Turno della chat del piano chiuso");
}

/** All'avvio i turni rimasti `running` sono stati interrotti dal riavvio: si chiudono con un messaggio. */
export async function failInterruptedPlanTurns(): Promise<number> {
  return db.transaction(async (tx) => {
    const interrupted = await tx
      .update(planConversationsTable)
      .set({ turnStatus: "idle", updatedAt: new Date() })
      .where(eq(planConversationsTable.turnStatus, "running"))
      .returning({ id: planConversationsTable.id });
    if (interrupted.length === 0) return 0;
    const ids = interrupted.map((c) => c.id);
    // Il messaggio vuoto del turno interrotto (l'ultimo per conversazione) diventa il messaggio d'errore;
    // se manca se ne crea uno
    const lastEmpties = await tx
      .select({ id: sql<number>`max(${planMessagesTable.id})::int` })
      .from(planMessagesTable)
      .where(and(inArray(planMessagesTable.conversationId, ids), eq(planMessagesTable.role, "assistant"), eq(planMessagesTable.content, "")))
      .groupBy(planMessagesTable.conversationId);
    const empties =
      lastEmpties.length === 0
        ? []
        : await tx
            .update(planMessagesTable)
            .set({ content: INTERRUPTED_TURN_MESSAGE, error: true })
            .where(inArray(planMessagesTable.id, lastEmpties.map((m) => m.id)))
            .returning({ conversationId: planMessagesTable.conversationId });
    const covered = new Set(empties.map((m) => m.conversationId));
    const missing = ids.filter((id) => !covered.has(id));
    if (missing.length > 0) {
      await tx
        .insert(planMessagesTable)
        .values(missing.map((conversationId) => ({ conversationId, role: "assistant" as const, content: INTERRUPTED_TURN_MESSAGE, error: true })));
    }
    return interrupted.length;
  });
}

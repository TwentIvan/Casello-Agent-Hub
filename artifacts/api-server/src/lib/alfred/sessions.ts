import { and, eq, lt, sql } from "drizzle-orm";
import { db, aiModelsTable, alfredConfirmationsTable, alfredSessionsTable, usersTable } from "@workspace/db";
import { ModelAccessError, computeCost, resolveModel, type ResolvedModel } from "../ai/executor";
import { ProviderError } from "../ai/discovery";
import { MODEL_UNAVAILABLE } from "../ai/choice";
import { characterBudgetBlock } from "../budget";
import { logger } from "../logger";
import { ALFRED_VOICES, DEFAULT_ALFRED_VOICE, bareModelName } from "./config";
import { AlfredError, createEphemeralToken } from "./gemini";
import { buildLiveConfig } from "./instructions";
import { memoryContextBlock } from "../memory/context";
import { summarizeConversation, TRANSCRIPT_MAX_CHARS } from "../memory/summaries";

// Sessioni di Alfred (spec §3): riga di sessione, token temporaneo di Gemini Live, consumi e pulizia.

export type AlfredSessionRow = typeof alfredSessionsTable.$inferSelect;

export interface AlfredSessionStart {
  sessionId: number;
  token: string;
  model: string;
  voice: string;
  expiresAt: string;
}

export const ALFRED_SESSION_MESSAGES = {
  noModel: "scegli il modello di Alfred in Account",
  notFound: "sessione non trovata",
  badCounters: "contatori non validi",
} as const;

/** Inattività oltre la quale una sessione si chiude; scadute da oltre un'ora, le conferme si cancellano. */
const IDLE_MS = 35 * 60_000;
const CONFIRMATION_RETENTION_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Tetto dei contatori (colonne intere a 32 bit). */
const MAX_COUNTER = 2_000_000_000;

/** Modello, account e tetti ancora validi; restituisce il modello risolto, voce e nome dell'utente. */
async function prepare(userId: number, sessionModelId?: number | null): Promise<{ resolved: ResolvedModel; voice: string; userName: string | null }> {
  const [user] = await db
    .select({ aiModelId: usersTable.alfredAiModelId, voice: usersTable.alfredVoice, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  // Il rinnovo usa il modello della sessione (a lui restano legati costo e spesa), l'avvio quello attuale dell'utente
  const modelId = sessionModelId === undefined ? user?.aiModelId : sessionModelId;
  if (!user || modelId === null || modelId === undefined) throw new AlfredError(ALFRED_SESSION_MESSAGES.noModel, 409);
  let resolved: ResolvedModel;
  try {
    resolved = await resolveModel(modelId, { userId, mustOwn: true });
  } catch (err) {
    if (err instanceof ModelAccessError) throw new AlfredError(err.message, 409);
    if (err instanceof ProviderError) throw new AlfredError(MODEL_UNAVAILABLE, 409);
    throw err;
  }
  if (resolved.provider !== "gemini") throw new AlfredError(MODEL_UNAVAILABLE, 409);
  const block = await characterBudgetBlock(userId, "alfred", resolved.aiModelId);
  if (block) throw new AlfredError(block, 409);
  const voice = user.voice && ALFRED_VOICES.includes(user.voice) ? user.voice : DEFAULT_ALFRED_VOICE;
  return { resolved, voice, userName: user.name };
}

async function issueToken(userId: number, resolved: ResolvedModel, voice: string, userName: string | null, resumptionHandle?: string) {
  // Appunti e titoli di Alfred entrano nelle istruzioni, che restano bloccate nel token
  const memory = await memoryContextBlock(userId, "alfred");
  return createEphemeralToken(resolved, buildLiveConfig({ voice, userName, memory, resumptionHandle }));
}

/**
 * Avvia una sessione: controlla modello e tetti, crea il token e SOLO DOPO la riga (chiudendo le altre attive
 * nella stessa transazione): se Gemini fallisce non resta nessuna sessione `active`.
 */
export async function startSession(userId: number): Promise<AlfredSessionStart> {
  const { resolved, voice, userName } = await prepare(userId);
  const { token, expiresAt } = await issueToken(userId, resolved, voice, userName);
  const sessionId = await db.transaction(async (tx) => {
    // Blocca la riga dell'utente: due avvii concorrenti si serializzano e resta una sola sessione attiva
    await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).for("update");
    await tx
      .update(alfredSessionsTable)
      .set({ status: "closed", closedAt: new Date() })
      .where(and(eq(alfredSessionsTable.userId, userId), eq(alfredSessionsTable.status, "active")));
    // Orari scritti dall'API e non dal default now() del DB (fuso della sessione): si confrontano con l'orologio dell'API
    const now = new Date();
    const [row] = await tx.insert(alfredSessionsTable).values({ userId, aiModelId: resolved.aiModelId, startedAt: now, lastActivityAt: now }).returning({ id: alfredSessionsTable.id });
    return row!.id;
  });
  return { sessionId, token, model: bareModelName(resolved.modelId), voice, expiresAt };
}

/** Sessione `active` dell'utente (altrimenti 404); aggiorna `last_activity_at`, salvo `touch: false` (letture di sola osservazione). */
export async function requireActiveSession(userId: number, id: number, opts: { touch?: boolean } = {}): Promise<AlfredSessionRow> {
  const where = and(eq(alfredSessionsTable.id, id), eq(alfredSessionsTable.userId, userId), eq(alfredSessionsTable.status, "active"));
  const [row] =
    opts.touch === false
      ? await db.select().from(alfredSessionsTable).where(where).limit(1)
      : await db.update(alfredSessionsTable).set({ lastActivityAt: new Date() }).where(where).returning();
  if (!row) throw new AlfredError(ALFRED_SESSION_MESSAGES.notFound, 404);
  return row;
}

/** Nuovo token per la stessa sessione attiva: ricontrolla modello e tetti. */
export async function renewSession(userId: number, id: number, resumptionHandle?: string): Promise<AlfredSessionStart> {
  const session = await requireActiveSession(userId, id);
  const { resolved, voice, userName } = await prepare(userId, session.aiModelId);
  const { token, expiresAt } = await issueToken(userId, resolved, voice, userName, resumptionHandle);
  return { sessionId: id, token, model: bareModelName(resolved.modelId), voice, expiresAt };
}

/** Contatori cumulativi: si tiene il massimo (mai all'indietro) e si ricalcola il costo; modello sparito → costo null. */
export async function recordUsage(userId: number, id: number, usage: { promptTokens: number; completionTokens: number }): Promise<void> {
  for (const n of [usage.promptTokens, usage.completionTokens]) {
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_COUNTER) throw new AlfredError(ALFRED_SESSION_MESSAGES.badCounters, 400);
  }
  const session = await requireActiveSession(userId, id);
  // Massimo in SQL: chiamate concorrenti non abbassano mai i contatori
  const [row] = await db
    .update(alfredSessionsTable)
    .set({
      promptTokens: sql`GREATEST(${alfredSessionsTable.promptTokens}, ${usage.promptTokens})`,
      completionTokens: sql`GREATEST(${alfredSessionsTable.completionTokens}, ${usage.completionTokens})`,
    })
    .where(and(eq(alfredSessionsTable.id, id), eq(alfredSessionsTable.status, "active")))
    .returning({ promptTokens: alfredSessionsTable.promptTokens, completionTokens: alfredSessionsTable.completionTokens });
  if (!row) return;
  // Prezzi letti dal modello (senza decifrare la chiave); modello sparito o senza prezzo → costo null
  let costUsd: number | null = null;
  if (session.aiModelId !== null) {
    const [m] = await db
      .select({ pin: aiModelsTable.priceInputPerMtok, pout: aiModelsTable.priceOutputPerMtok })
      .from(aiModelsTable)
      .where(eq(aiModelsTable.id, session.aiModelId))
      .limit(1);
    if (m && m.pin !== null && m.pout !== null) costUsd = computeCost(row.promptTokens, row.completionTokens, Number(m.pin), Number(m.pout));
  }
  // Il costo segue i contatori: si scrive solo se questi sono ancora quelli letti (un'altra chiamata più alta lo riscrive)
  await db
    .update(alfredSessionsTable)
    .set({ costUsd: costUsd === null ? null : costUsd.toFixed(8) })
    .where(
      and(
        eq(alfredSessionsTable.id, id),
        eq(alfredSessionsTable.promptTokens, row.promptTokens),
        eq(alfredSessionsTable.completionTokens, row.completionTokens),
      ),
    );
}

const romeFormat = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** «Conversazione del dd/mm/yyyy HH:mm», ora italiana. */
export function sessionTitle(at: Date): string {
  const p = Object.fromEntries(romeFormat.formatToParts(at).map((x) => [x.type, x.value]));
  return `Conversazione del ${p["day"]}/${p["month"]}/${p["year"]} ${p["hour"]}:${p["minute"]}`;
}

/**
 * Chiude la sessione (idempotente per una propria già chiusa); altrui o inesistente → 404. Con una trascrizione non
 * vuota, alla prima chiusura parte in background il riassunto per lo storico; la trascrizione non si salva né si registra.
 */
export async function closeSession(userId: number, id: number, transcript?: string): Promise<void> {
  const closed = await db
    .update(alfredSessionsTable)
    .set({ status: "closed", closedAt: new Date() })
    .where(and(eq(alfredSessionsTable.id, id), eq(alfredSessionsTable.userId, userId), eq(alfredSessionsTable.status, "active")))
    .returning({ id: alfredSessionsTable.id });
  if (closed.length > 0) {
    const text = transcript?.trim();
    if (text) {
      const input = { userId, character: "alfred" as const, kind: "alfred_session" as const, refId: id, title: sessionTitle(new Date()), transcript: text.slice(-TRANSCRIPT_MAX_CHARS) };
      void summarizeConversation(input).catch((err: unknown) =>
        logger.error({ errName: err instanceof Error ? err.name : "Error", sessionId: id }, "Riassunto della sessione di Alfred non riuscito"),
      );
    }
    return;
  }
  const [own] = await db
    .select({ id: alfredSessionsTable.id })
    .from(alfredSessionsTable)
    .where(and(eq(alfredSessionsTable.id, id), eq(alfredSessionsTable.userId, userId)))
    .limit(1);
  if (!own) throw new AlfredError(ALFRED_SESSION_MESSAGES.notFound, 404);
}

/** Chiude le sessioni inattive da 35 minuti e cancella le conferme scadute da oltre un'ora. */
export async function sweepAlfred(now: Date = new Date()): Promise<void> {
  await db
    .update(alfredSessionsTable)
    .set({ status: "closed", closedAt: now })
    .where(and(eq(alfredSessionsTable.status, "active"), lt(alfredSessionsTable.lastActivityAt, new Date(now.getTime() - IDLE_MS))));
  await db
    .delete(alfredConfirmationsTable)
    .where(lt(alfredConfirmationsTable.expiresAt, new Date(now.getTime() - CONFIRMATION_RETENTION_MS)));
}

/** All'avvio dell'API nessuna pagina è più collegata: tutte le sessioni attive si chiudono. */
export async function closeAllActiveSessions(): Promise<number> {
  const rows = await db
    .update(alfredSessionsTable)
    .set({ status: "closed", closedAt: new Date() })
    .where(eq(alfredSessionsTable.status, "active"))
    .returning({ id: alfredSessionsTable.id });
  return rows.length;
}

/** Controllo ogni 5 minuti; un errore si registra col solo nome. */
export function startAlfredSweeper(): () => void {
  const timer = setInterval(() => {
    void sweepAlfred().catch((err: unknown) =>
      logger.error({ errName: err instanceof Error ? err.name : "Error" }, "Pulizia di Alfred non riuscita"),
    );
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

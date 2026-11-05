import { and, eq, lt } from "drizzle-orm";
import { db, alfredConfirmationsTable, alfredSessionsTable, usersTable } from "@workspace/db";
import { ModelAccessError, computeCost, resolveModel, type ResolvedModel } from "../ai/executor";
import { ProviderError } from "../ai/discovery";
import { MODEL_UNAVAILABLE } from "../ai/choice";
import { userBudgetBlock } from "../budget";
import { logger } from "../logger";
import { ALFRED_VOICES, DEFAULT_ALFRED_VOICE, bareModelName } from "./config";
import { AlfredError, createEphemeralToken } from "./gemini";
import { buildLiveConfig } from "./instructions";

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
async function prepare(userId: number): Promise<{ resolved: ResolvedModel; voice: string; userName: string | null }> {
  const [user] = await db
    .select({ aiModelId: usersTable.alfredAiModelId, voice: usersTable.alfredVoice, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user || user.aiModelId === null) throw new AlfredError(ALFRED_SESSION_MESSAGES.noModel, 409);
  let resolved: ResolvedModel;
  try {
    resolved = await resolveModel(user.aiModelId, { userId, mustOwn: true });
  } catch (err) {
    if (err instanceof ModelAccessError) throw new AlfredError(err.message, 409);
    if (err instanceof ProviderError) throw new AlfredError(MODEL_UNAVAILABLE, 409);
    throw err;
  }
  if (resolved.provider !== "gemini") throw new AlfredError(MODEL_UNAVAILABLE, 409);
  const block = await userBudgetBlock(resolved.aiModelId);
  if (block) throw new AlfredError(block, 409);
  const voice = user.voice && ALFRED_VOICES.includes(user.voice) ? user.voice : DEFAULT_ALFRED_VOICE;
  return { resolved, voice, userName: user.name };
}

async function issueToken(resolved: ResolvedModel, voice: string, userName: string | null) {
  return createEphemeralToken(resolved, buildLiveConfig({ voice, userName }));
}

/**
 * Avvia una sessione: controlla modello e tetti, crea il token e SOLO DOPO la riga (chiudendo le altre attive
 * nella stessa transazione): se Gemini fallisce non resta nessuna sessione `active`.
 */
export async function startSession(userId: number): Promise<AlfredSessionStart> {
  const { resolved, voice, userName } = await prepare(userId);
  const { token, expiresAt } = await issueToken(resolved, voice, userName);
  const sessionId = await db.transaction(async (tx) => {
    await tx
      .update(alfredSessionsTable)
      .set({ status: "closed", closedAt: new Date() })
      .where(and(eq(alfredSessionsTable.userId, userId), eq(alfredSessionsTable.status, "active")));
    const [row] = await tx.insert(alfredSessionsTable).values({ userId, aiModelId: resolved.aiModelId }).returning({ id: alfredSessionsTable.id });
    return row!.id;
  });
  return { sessionId, token, model: bareModelName(resolved.modelId), voice, expiresAt };
}

/** Sessione `active` dell'utente (altrimenti 404); aggiorna `last_activity_at`. */
export async function requireActiveSession(userId: number, id: number): Promise<AlfredSessionRow> {
  const [row] = await db
    .update(alfredSessionsTable)
    .set({ lastActivityAt: new Date() })
    .where(and(eq(alfredSessionsTable.id, id), eq(alfredSessionsTable.userId, userId), eq(alfredSessionsTable.status, "active")))
    .returning();
  if (!row) throw new AlfredError(ALFRED_SESSION_MESSAGES.notFound, 404);
  return row;
}

/** Nuovo token per la stessa sessione attiva: ricontrolla modello e tetti. */
export async function renewSession(userId: number, id: number): Promise<AlfredSessionStart> {
  await requireActiveSession(userId, id);
  const { resolved, voice, userName } = await prepare(userId);
  const { token, expiresAt } = await issueToken(resolved, voice, userName);
  return { sessionId: id, token, model: bareModelName(resolved.modelId), voice, expiresAt };
}

/** Contatori cumulativi: si tiene il massimo (mai all'indietro) e si ricalcola il costo; modello sparito → costo null. */
export async function recordUsage(userId: number, id: number, usage: { promptTokens: number; completionTokens: number }): Promise<void> {
  for (const n of [usage.promptTokens, usage.completionTokens]) {
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_COUNTER) throw new AlfredError(ALFRED_SESSION_MESSAGES.badCounters, 400);
  }
  const session = await requireActiveSession(userId, id);
  const promptTokens = Math.max(session.promptTokens, usage.promptTokens);
  const completionTokens = Math.max(session.completionTokens, usage.completionTokens);
  let costUsd: number | null = null;
  if (session.aiModelId !== null) {
    try {
      const resolved = await resolveModel(session.aiModelId, { userId: null, mustOwn: false });
      costUsd = computeCost(promptTokens, completionTokens, resolved.priceInput, resolved.priceOutput);
    } catch {
      costUsd = null;
    }
  }
  await db
    .update(alfredSessionsTable)
    .set({ promptTokens, completionTokens, costUsd: costUsd === null ? null : costUsd.toFixed(8) })
    .where(and(eq(alfredSessionsTable.id, id), eq(alfredSessionsTable.status, "active")));
}

/** Chiude la sessione (idempotente per una propria già chiusa); altrui o inesistente → 404. */
export async function closeSession(userId: number, id: number): Promise<void> {
  const closed = await db
    .update(alfredSessionsTable)
    .set({ status: "closed", closedAt: new Date() })
    .where(and(eq(alfredSessionsTable.id, id), eq(alfredSessionsTable.userId, userId), eq(alfredSessionsTable.status, "active")))
    .returning({ id: alfredSessionsTable.id });
  if (closed.length > 0) return;
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

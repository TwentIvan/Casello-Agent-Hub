// Coda dei turni delegati al nodo (spec §2-§3): accodamento con il token `cat_…`, attesa dell'esito, annullamento,
// lettura del turno dal token di `/mcp/turn`. Nel DB solo l'hash del token: il valore in chiaro resta in memoria fino
// alla presa del nodo (poi è nel pacchetto consegnato), mai in `package`. Gli avvisi sono in memoria: uno per nodo
// (turno accodato, sveglia il claim in attesa) e uno per turno (turno chiuso, risolve `waitTurn`).

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db, nodeTurnsTable, type NodeTurn } from "@workspace/db";
import { normalizeErrorCode, type NodeTurnErrorCode } from "./messages";

export type NodeTurnConsumer = NodeTurn["consumer"];

/** Pacchetto del turno senza i campi che aggiunge la presa (`id`, `leaseToken`, `turnToken`, `mcpUrl`). */
export interface TurnPackageBody {
  model: string;
  systemPrompt: string;
  prompt: string;
  maxTurns: number;
  timeoutMs: number;
}

export interface NodeTurnResult {
  status: "done" | "failed" | "cancelled" | "expired";
  content: string | null;
  errorCode: NodeTurnErrorCode | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: string | null;
}

export const OPEN_TURN_STATUSES = ["queued", "running"] as const;
const CLOSED_STATUSES = new Set<string>(["done", "failed", "cancelled", "expired"]);
/** Riletture di riserva durante l'attesa, nel caso un avviso vada perso. */
const WAIT_RECHECK_MS = 5_000;

const events = new EventEmitter();
events.setMaxListeners(0);

/**
 * Token in chiaro dei turni non ancora presi, per hash del token: si scrive prima dell'INSERT, così una presa che vede
 * la riga appena committata trova già il token.
 */
const pendingTokens = new Map<string, string>();
/** Hash del token dei turni accodati da questo processo, per id del turno (per dimenticare il token alla chiusura). */
const pendingHashes = new Map<number, string>();

const nodeEvent = (nodeId: number) => `node:${nodeId}`;
const turnEvent = (turnId: number) => `turn:${turnId}`;

export const hashTurnToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Accoda il turno per il nodo e sveglia il suo claim in attesa; il token in chiaro lo riceve il nodo alla presa. */
export async function enqueueTurn(input: {
  nodeId: number;
  userId: number;
  aiModelId: number;
  consumer: NodeTurnConsumer;
  refId: number;
  messageId?: number;
  pkg: TurnPackageBody;
}): Promise<{ turnId: number; turnToken: string }> {
  const turnToken = `cat_${randomBytes(32).toString("base64url")}`;
  const hash = hashTurnToken(turnToken);
  pendingTokens.set(hash, turnToken);
  let row: { id: number } | undefined;
  try {
    [row] = await db
      .insert(nodeTurnsTable)
      .values({
        nodeId: input.nodeId,
        userId: input.userId,
        aiModelId: input.aiModelId,
        consumer: input.consumer,
        refId: input.refId,
        messageId: input.messageId ?? null,
        status: "queued",
        package: { ...input.pkg },
        turnTokenHash: hash,
        // Dall'orologio dell'API (come le altre date del turno): la scadenza della presa la confronta con lo stesso orologio
        createdAt: new Date(),
      })
      .returning({ id: nodeTurnsTable.id });
  } catch (err) {
    pendingTokens.delete(hash);
    throw err;
  }
  pendingHashes.set(row!.id, hash);
  events.emit(nodeEvent(input.nodeId));
  return { turnId: row!.id, turnToken };
}

/** Token in chiaro di un turno in coda, dall'hash salvato nella riga; undefined se perso (riavvio). */
export function pendingToken(tokenHash: string): string | undefined {
  return pendingTokens.get(tokenHash);
}

/** Dopo la presa (o la chiusura) il token in chiaro non serve più a questo processo. */
export function forgetPendingToken(turnId: number, tokenHash?: string): void {
  const hash = tokenHash ?? pendingHashes.get(turnId);
  if (hash) pendingTokens.delete(hash);
  pendingHashes.delete(turnId);
}

export interface NodeSignalSubscription {
  /** Attende fino a `ms` un avviso (subito vero se è già arrivato dopo l'iscrizione); false se scaduto o annullato. */
  wait(ms: number, signal?: AbortSignal): Promise<boolean>;
  /** Toglie l'iscrizione (da chiamare in ogni caso). */
  close(): void;
}

/**
 * Iscrizione agli avvisi del nodo (turno accodato), da fare PRIMA di cercare un turno: un turno accodato tra la ricerca
 * e l'attesa non va perso.
 */
export function subscribeNodeSignal(nodeId: number): NodeSignalSubscription {
  let fired = false;
  let wake: (() => void) | null = null;
  const onEvent = () => {
    fired = true;
    wake?.();
  };
  events.on(nodeEvent(nodeId), onEvent);
  return {
    wait(ms, signal) {
      return new Promise((resolve) => {
        if (fired) return resolve(true);
        if (signal?.aborted || ms <= 0) return resolve(false);
        const done = (woken: boolean) => {
          clearTimeout(timer);
          wake = null;
          signal?.removeEventListener("abort", onAbort);
          resolve(woken);
        };
        const onAbort = () => done(false);
        const timer = setTimeout(() => done(false), ms);
        wake = () => done(true);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    close() {
      events.off(nodeEvent(nodeId), onEvent);
      wake = null;
    },
  };
}

/** Dopo il commit di una chiusura: risolve le attese e dimentica i token mai consegnati. */
export function notifyTurnsClosed(turnIds: number[]): void {
  for (const id of turnIds) {
    forgetPendingToken(id);
    events.emit(turnEvent(id));
  }
}

function toResult(row: NodeTurn): NodeTurnResult {
  return {
    status: row.status as NodeTurnResult["status"],
    content: row.content,
    errorCode: row.errorCode === null ? null : normalizeErrorCode(row.errorCode),
    promptTokens: row.promptTokens ?? 0,
    completionTokens: row.completionTokens ?? 0,
    cachedTokens: row.cachedTokens ?? 0,
    costUsd: row.costUsd,
  };
}

async function readTurn(turnId: number): Promise<NodeTurn | undefined> {
  const [row] = await db.select().from(nodeTurnsTable).where(eq(nodeTurnsTable.id, turnId)).limit(1);
  return row;
}

/** Chiude `cancelled` un turno ancora aperto (il ping successivo del nodo riceve 409). */
export async function cancelTurn(turnId: number): Promise<void> {
  const closed = await db
    .update(nodeTurnsTable)
    .set({ status: "cancelled", package: null, finishedAt: new Date() })
    .where(and(eq(nodeTurnsTable.id, turnId), inArray(nodeTurnsTable.status, [...OPEN_TURN_STATUSES])))
    .returning({ id: nodeTurnsTable.id });
  notifyTurnsClosed(closed.map((r) => r.id));
}

/**
 * Chiude `cancelled` tutti i turni ancora aperti di un consumatore per un riferimento (conversazione o run): serve a
 * «Ferma» quando il turno non gira in questo processo. Restituisce quanti ne ha chiusi.
 */
export async function cancelOpenTurnsFor(consumer: NodeTurnConsumer, refId: number): Promise<number> {
  const closed = await db
    .update(nodeTurnsTable)
    .set({ status: "cancelled", package: null, finishedAt: new Date() })
    .where(
      and(eq(nodeTurnsTable.consumer, consumer), eq(nodeTurnsTable.refId, refId), inArray(nodeTurnsTable.status, [...OPEN_TURN_STATUSES])),
    )
    .returning({ id: nodeTurnsTable.id });
  notifyTurnsClosed(closed.map((r) => r.id));
  return closed.length;
}

/**
 * Attende che il turno arrivi a uno stato finale (report, scadenza, lease persa, annullamento, nodo fermato) e ne
 * restituisce l'esito. Con `signal` annullato chiude il turno `cancelled` e restituisce lo stato registrato (cancelled,
 * oppure l'esito arrivato appena prima). Turno inesistente (riga cancellata) → `failed` `restart`.
 */
export async function waitTurn(turnId: number, signal?: AbortSignal): Promise<NodeTurnResult> {
  for (;;) {
    // Iscrizione prima della lettura: una chiusura tra le due non si perde
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => (wake = resolve));
    const onEvent = () => wake();
    const onAbort = () => wake();
    events.once(turnEvent(turnId), onEvent);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(onEvent, WAIT_RECHECK_MS);
    try {
      if (signal?.aborted) {
        await cancelTurn(turnId);
        const row = await readTurn(turnId);
        return row ? toResult(row) : missingResult();
      }
      const row = await readTurn(turnId);
      if (!row) return missingResult();
      if (CLOSED_STATUSES.has(row.status)) return toResult(row);
      await woken;
    } finally {
      clearTimeout(timer);
      events.off(turnEvent(turnId), onEvent);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

const missingResult = (): NodeTurnResult => ({
  status: "failed",
  content: null,
  errorCode: "restart",
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  costUsd: null,
});

/** Turno di un token `cat_…` valido su `/mcp/turn`: solo `running` con lease non scaduta. */
export async function turnByToken(token: string): Promise<{ id: number; userId: number } | null> {
  if (!token.startsWith("cat_")) return null;
  const [row] = await db
    .select({ id: nodeTurnsTable.id, userId: nodeTurnsTable.userId })
    .from(nodeTurnsTable)
    .where(and(eq(nodeTurnsTable.turnTokenHash, hashTurnToken(token)), eq(nodeTurnsTable.status, "running"), gt(nodeTurnsTable.leaseExpiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

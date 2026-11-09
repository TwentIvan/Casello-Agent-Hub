// Protocollo del nodo per i turni delegati (spec §3): presa con attesa lunga, rinnovo della lease e report. Il nodo è
// quello del token d'ambito `node`; un turno va solo al nodo a cui è destinato. Presa con FOR UPDATE SKIP LOCKED e
// UPDATE condizionato; ping e report condizionati alla lease e a `running`: un turno si chiude una volta sola.

import { randomBytes } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { db, nodesTable, nodeTurnsTable, type NodeTurn } from "@workspace/db";
import { NODE_PROTOCOL_MESSAGES, NodeError } from "../nodes/protocol";
import { oauthBase } from "../oauth/config";
import { normalizeErrorCode } from "./messages";
import { forgetPendingToken, notifyTurnsClosed, pendingToken, waitForNodeSignal, type TurnPackageBody } from "./queue";

/** Attesa massima della presa senza turni in coda. */
export const TURN_POLL_WAIT_MS = 25_000;
/** Durata della lease di un turno preso, rinnovata da ogni ping. */
export const TURN_LEASE_MS = 2 * 60_000;
/** Lunghezza massima della risposta riferita (oltre si tronca). */
export const MAX_TURN_CONTENT = 20_000;

/** Attesa della presa usata dalla route (i test la accorciano). */
export const turnPollSettings = { waitMs: TURN_POLL_WAIT_MS };

export interface TurnPackage extends TurnPackageBody {
  id: number;
  leaseToken: string;
  mcpUrl: string;
  turnToken: string;
}

export interface NodeTurnReport {
  leaseToken: string;
  status: "done" | "failed";
  content?: string;
  errorCode?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
  sessionId?: string;
}

type ClaimAttempt = { kind: "claimed"; turn: NodeTurn; turnToken: string } | { kind: "lost"; turnId: number } | { kind: "none" };

/**
 * Prende il turno `queued` più vecchio del nodo (SKIP LOCKED: due prese insieme non prendono lo stesso turno). Un turno
 * il cui token in chiaro non è più in memoria non si può consegnare: chiude `failed` `restart` e si passa al successivo.
 */
async function tryClaim(nodeId: number): Promise<ClaimAttempt> {
  return db.transaction(async (tx): Promise<ClaimAttempt> => {
    const [free] = await tx
      .select({ id: nodeTurnsTable.id, turnTokenHash: nodeTurnsTable.turnTokenHash })
      .from(nodeTurnsTable)
      .where(and(eq(nodeTurnsTable.nodeId, nodeId), eq(nodeTurnsTable.status, "queued")))
      .orderBy(asc(nodeTurnsTable.createdAt), asc(nodeTurnsTable.id))
      .for("update", { skipLocked: true })
      .limit(1);
    if (!free) return { kind: "none" };
    const turnToken = pendingToken(free.turnTokenHash);
    const now = new Date();
    if (!turnToken) {
      await tx
        .update(nodeTurnsTable)
        .set({ status: "failed", errorCode: "restart", package: null, finishedAt: now })
        .where(and(eq(nodeTurnsTable.id, free.id), eq(nodeTurnsTable.status, "queued")));
      return { kind: "lost", turnId: free.id };
    }
    const [turn] = await tx
      .update(nodeTurnsTable)
      .set({
        status: "running",
        claimedAt: now,
        leaseToken: randomBytes(32).toString("base64url"),
        leaseExpiresAt: new Date(now.getTime() + TURN_LEASE_MS),
      })
      .where(and(eq(nodeTurnsTable.id, free.id), eq(nodeTurnsTable.status, "queued")))
      .returning();
    return turn ? { kind: "claimed", turn, turnToken } : { kind: "none" };
  });
}

function toPackage(turn: NodeTurn, turnToken: string): TurnPackage {
  const body = turn.package as unknown as TurnPackageBody;
  return {
    id: turn.id,
    leaseToken: turn.leaseToken!,
    model: body.model,
    systemPrompt: body.systemPrompt,
    prompt: body.prompt,
    mcpUrl: `${oauthBase().issuer}/mcp/turn`,
    turnToken,
    maxTurns: body.maxTurns,
    timeoutMs: body.timeoutMs,
  };
}

async function claimOnce(nodeId: number): Promise<TurnPackage | null> {
  for (;;) {
    const attempt = await tryClaim(nodeId);
    if (attempt.kind === "none") return null;
    if (attempt.kind === "lost") {
      notifyTurnsClosed([attempt.turnId]);
      continue;
    }
    // Dopo il commit: il token è nel pacchetto consegnato, il processo non lo tiene più
    forgetPendingToken(attempt.turn.id, attempt.turn.turnTokenHash);
    return toPackage(attempt.turn, attempt.turnToken);
  }
}

/**
 * Presa di un turno: registra la presenza del nodo (`last_turn_poll_at`), prende il turno più vecchio; se non c'è
 * attende fino a `waitMs` un avviso e ritenta una volta. Null se non c'è nulla o se `signal` è annullato (client
 * disconnesso). Nodo non attivo → 403.
 */
export async function claimTurn(nodeId: number, waitMs: number = TURN_POLL_WAIT_MS, signal?: AbortSignal): Promise<TurnPackage | null> {
  const [node] = await db
    .update(nodesTable)
    .set({ lastTurnPollAt: new Date() })
    .where(and(eq(nodesTable.id, nodeId), eq(nodesTable.status, "active")))
    .returning({ id: nodesTable.id });
  if (!node) throw new NodeError(403, NODE_PROTOCOL_MESSAGES.disabled);
  if (signal?.aborted) return null;
  const first = await claimOnce(nodeId);
  if (first || waitMs <= 0) return first;
  await waitForNodeSignal(nodeId, waitMs, signal);
  if (signal?.aborted) return null;
  return claimOnce(nodeId);
}

/** Rinnova di TURN_LEASE_MS la lease del turno; turno chiuso, annullato, lease diversa o scaduta → 409. */
export async function pingTurn(nodeId: number, turnId: number, leaseToken: string): Promise<{ leaseExpiresAt: Date }> {
  const now = new Date();
  const [row] = await db
    .update(nodeTurnsTable)
    .set({ leaseExpiresAt: new Date(now.getTime() + TURN_LEASE_MS) })
    .where(
      and(
        eq(nodeTurnsTable.id, turnId),
        eq(nodeTurnsTable.nodeId, nodeId),
        eq(nodeTurnsTable.status, "running"),
        eq(nodeTurnsTable.leaseToken, leaseToken),
        gt(nodeTurnsTable.leaseExpiresAt, now),
      ),
    )
    .returning({ leaseExpiresAt: nodeTurnsTable.leaseExpiresAt });
  if (!row?.leaseExpiresAt) throw new NodeError(409, NODE_PROTOCOL_MESSAGES.lease);
  return { leaseExpiresAt: row.leaseExpiresAt };
}

/**
 * Chiude il turno con l'esito del nodo, una volta sola (condizionato a `running`, al nodo e alla lease). Contenuto
 * troncato a MAX_TURN_CONTENT, codice d'errore fuori elenco → `claude_failed` (solo per `failed`), pacchetto svuotato.
 * Altrimenti 409 e nulla salvato.
 */
export async function reportTurn(nodeId: number, turnId: number, body: NodeTurnReport): Promise<void> {
  const [row] = await db
    .update(nodeTurnsTable)
    .set({
      status: body.status,
      content: body.content === undefined ? null : body.content.slice(0, MAX_TURN_CONTENT),
      errorCode: body.status === "failed" ? normalizeErrorCode(body.errorCode) : null,
      promptTokens: body.promptTokens ?? null,
      completionTokens: body.completionTokens ?? null,
      cachedTokens: body.cachedTokens ?? null,
      costUsd: body.costUsd === undefined ? null : body.costUsd.toFixed(6),
      sessionId: body.sessionId ?? null,
      package: null,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(nodeTurnsTable.id, turnId),
        eq(nodeTurnsTable.nodeId, nodeId),
        eq(nodeTurnsTable.status, "running"),
        eq(nodeTurnsTable.leaseToken, body.leaseToken),
      ),
    )
    .returning({ id: nodeTurnsTable.id });
  if (!row) throw new NodeError(409, NODE_PROTOCOL_MESSAGES.lease);
  notifyTurnsClosed([row.id]);
}

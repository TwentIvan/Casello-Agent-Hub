// Nodi locali registrati: creazione con token d'ambito `node`, elenco, disattivazione, rigenerazione del
// token ed eliminazione. Un nodo è dell'utente che lo registra; quello di un altro utente non esiste (null).
// Disattivare, eliminare o rigenerare il token ferma i compiti che il nodo ha in carico: nella stessa transazione (riga
// del nodo bloccata) chiudono `failed` «nodo disattivato» con la lease tolta, dopo il commit PLAN, evento e turno del capo.
// Lo stesso vale per i turni delegati al nodo (`node_turns`): chiudono `failed` `node_disabled`, l'attesa di chi li ha
// delegati si risolve dopo il commit.

import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, apiTokensTable, nodesTable, teamTasksTable, type Node, type TeamTaskRow } from "@workspace/db";
import { createNodeToken } from "../api-tokens";
import { nodeTurnReady } from "../ai/node-account";
import { notifyTurnsClosed } from "../node-turns/queue";
import { failNodeTurns } from "../node-turns/sweeper";
import { logger } from "../logger";
import { isUniqueViolation } from "../pg-errors";
import { closeTaskRow, errName, notifyTaskClosed, type TaskResult } from "../teams/task-runner";
import { NODE_PROTOCOL_MESSAGES } from "./protocol";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Un nodo è vivo se ha comunicato negli ultimi 2 minuti. */
export const NODE_ONLINE_WINDOW_MS = 2 * 60_000;
const NAME_MAX = 100;

export const NODE_MESSAGES = {
  nameUsed: "nome già usato",
  nameInvalid: `nome obbligatorio, al massimo ${NAME_MAX} caratteri`,
  notFound: "nodo non trovato",
} as const;

export interface NodeView {
  id: number;
  name: string;
  status: "active" | "disabled";
  executor: string | null;
  version: string | null;
  skills: string[];
  workspaceRoot: string | null;
  maxConcurrent: number;
  lastSeenAt: Date | null;
  online: boolean;
  /** Pronto per i turni delegati: attivo e ha chiesto un turno negli ultimi 60 s. */
  turnReady: boolean;
}

/** Nome vuoto o troppo lungo: il messaggio va nel 400. */
export class NodeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeInputError";
  }
}

/** Il nome esiste già per l'utente: 409. */
export class NodeNameConflictError extends Error {
  constructor() {
    super(NODE_MESSAGES.nameUsed);
    this.name = "NodeNameConflictError";
  }
}

export function toNodeView(row: Node, now: Date = new Date()): NodeView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    executor: row.executor,
    version: row.version,
    skills: row.skills,
    workspaceRoot: row.workspaceRoot,
    maxConcurrent: row.maxConcurrent,
    lastSeenAt: row.lastSeenAt,
    online: row.lastSeenAt !== null && now.getTime() - row.lastSeenAt.getTime() <= NODE_ONLINE_WINDOW_MS,
    turnReady: nodeTurnReady(row, now),
  };
}

/** Registra un nodo e il suo token (mostrato una sola volta), in una transazione. */
export async function createNode(userId: number, name: string): Promise<{ node: NodeView; token: string }> {
  const cleanName = name.trim();
  if (cleanName.length < 1 || cleanName.length > NAME_MAX) throw new NodeInputError(NODE_MESSAGES.nameInvalid);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(nodesTable).values({ userId, name: cleanName }).returning();
      const token = await createNodeToken(tx, userId, row!.id, `Nodo ${cleanName}`);
      return { node: toNodeView(row!), token };
    });
  } catch (err) {
    if (isUniqueViolation(err, "nodes_user_name_unique")) throw new NodeNameConflictError();
    throw err;
  }
}

export interface NodeFoldersView {
  nodeId: number;
  workspaceRoot: string | null;
  folders: string[] | null;
  foldersUpdatedAt: Date | null;
}

/** Cartelle comunicate dal nodo con l'heartbeat; null se il nodo non è dell'utente. */
export async function getNodeFolders(userId: number, id: number): Promise<NodeFoldersView | null> {
  const [row] = await db
    .select({
      workspaceRoot: nodesTable.workspaceRoot,
      folders: nodesTable.workspaceFolders,
      foldersUpdatedAt: nodesTable.foldersUpdatedAt,
    })
    .from(nodesTable)
    .where(and(eq(nodesTable.id, id), eq(nodesTable.userId, userId)));
  return row ? { nodeId: id, ...row } : null;
}

/** Nodi dell'utente, per nome. */
export async function listNodes(userId: number): Promise<NodeView[]> {
  const rows = await db.select().from(nodesTable).where(eq(nodesTable.userId, userId)).orderBy(asc(nodesTable.name), asc(nodesTable.id));
  const now = new Date();
  return rows.map((row) => toNodeView(row, now));
}

const NODE_STOPPED: TaskResult = { status: "failed", outcome: NODE_PROTOCOL_MESSAGES.disabled, error: NODE_PROTOCOL_MESSAGES.disabled };

/**
 * Nella transazione, con la riga del nodo già bloccata: i compiti `running` che il nodo ha in lease chiudono `failed`
 * «nodo disattivato» (guardia `node`: stessa lease, una volta sola) e perdono la lease. Restituisce quelli chiusi.
 */
async function stopNodeTasks(tx: Tx, nodeId: number): Promise<TeamTaskRow[]> {
  const leased = await tx
    .select()
    .from(teamTasksTable)
    .where(and(eq(teamTasksTable.nodeId, nodeId), eq(teamTasksTable.status, "running"), isNotNull(teamTasksTable.leaseToken)))
    .for("update");
  const closed: TeamTaskRow[] = [];
  for (const task of leased) {
    const usage = { promptTokens: null, completionTokens: null, costUsd: null };
    if (await closeTaskRow(tx, task, NODE_STOPPED, usage, { kind: "node", nodeId, leaseToken: task.leaseToken! })) closed.push(task);
  }
  return closed;
}

interface StoppedWork {
  tasks: TeamTaskRow[];
  turnIds: number[];
}

/** Nella transazione, con la riga del nodo bloccata: ferma compiti e turni del nodo. */
async function stopNodeWork(tx: Tx, nodeId: number): Promise<StoppedWork> {
  return { tasks: await stopNodeTasks(tx, nodeId), turnIds: await failNodeTurns(tx, nodeId) };
}

/** Dopo il commit: attese dei turni risolte; PLAN, evento `bloccato` e turno del capo per ogni compito fermato (un errore non ferma gli altri). */
async function notifyStopped({ tasks, turnIds }: StoppedWork): Promise<void> {
  notifyTurnsClosed(turnIds);
  for (const task of tasks) {
    try {
      await notifyTaskClosed(task, NODE_STOPPED);
    } catch (err) {
      logger.error({ teamTaskId: task.id, errName: errName(err) }, "Notifica del compito fermato con il nodo non riuscita");
    }
  }
}

/** Disattiva il nodo (il suo token smette di valere sul protocollo) e ne ferma i compiti; null se non è dell'utente. */
export async function disableNode(userId: number, id: number): Promise<NodeView | null> {
  const out = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(nodesTable)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(and(eq(nodesTable.id, id), eq(nodesTable.userId, userId)))
      .returning();
    if (!row) return null;
    return { row, stopped: await stopNodeWork(tx, id) };
  });
  if (!out) return null;
  await notifyStopped(out.stopped);
  return toNodeView(out.row);
}

/** Elimina il nodo e i suoi token (cascade), dopo averne fermato i compiti; false se non è dell'utente. */
export async function deleteNode(userId: number, id: number): Promise<boolean> {
  const stopped = await db.transaction(async (tx) => {
    const [node] = await tx
      .select({ id: nodesTable.id })
      .from(nodesTable)
      .where(and(eq(nodesTable.id, id), eq(nodesTable.userId, userId)))
      .for("update");
    if (!node) return null;
    // Prima dell'eliminazione: poi `node_id` diventa null e compiti e turni del nodo non si riconoscerebbero più
    const work = await stopNodeWork(tx, id);
    await tx.delete(nodesTable).where(eq(nodesTable.id, id));
    return work;
  });
  if (!stopped) return false;
  await notifyStopped(stopped);
  return true;
}

/**
 * Revoca i token del nodo e ne crea uno nuovo (mostrato una sola volta); null se il nodo non è dell'utente. Il processo
 * col vecchio token non potrebbe più riferire: i compiti che ha in carico si fermano come con la disattivazione.
 */
export async function regenerateNodeToken(userId: number, id: number): Promise<{ token: string } | null> {
  const out = await db.transaction(async (tx) => {
    // Riga del nodo bloccata: due rigenerazioni insieme non lasciano due token validi
    const [node] = await tx
      .select()
      .from(nodesTable)
      .where(and(eq(nodesTable.id, id), eq(nodesTable.userId, userId)))
      .for("update");
    if (!node) return null;
    await tx
      .update(apiTokensTable)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokensTable.nodeId, id), isNull(apiTokensTable.revokedAt)));
    const stopped = await stopNodeWork(tx, id);
    return { token: await createNodeToken(tx, userId, id, `Nodo ${node.name}`), stopped };
  });
  if (!out) return null;
  await notifyStopped(out.stopped);
  return { token: out.token };
}

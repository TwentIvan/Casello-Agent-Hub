// Nodi locali registrati: creazione con token d'ambito `node`, elenco, disattivazione, rigenerazione del
// token ed eliminazione. Un nodo è dell'utente che lo registra; quello di un altro utente non esiste (null).
// Disattivare, eliminare o rigenerare il token ferma i compiti che il nodo ha in carico: nella stessa transazione (riga
// del nodo bloccata) chiudono `failed` «nodo disattivato» con la lease tolta, dopo il commit PLAN, evento e turno del capo.
// Lo stesso vale per i turni delegati al nodo (`node_turns`): chiudono `failed` `node_disabled`, l'attesa di chi li ha
// delegati si risolve dopo il commit.

import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, apiTokensTable, nodeDiagnosticsTable, nodesTable, teamTasksTable, type Node, type TeamTaskRow } from "@workspace/db";
import { createNodeToken } from "../api-tokens";
import { nodeTurnReady } from "../ai/node-account";
import { notifyTurnsClosed } from "../node-turns/queue";
import { failNodeTurns } from "../node-turns/sweeper";
import { logger } from "../logger";
import { isUniqueViolation } from "../pg-errors";
import { closeTaskRow, errName, notifyTaskClosed, type TaskResult } from "../teams/task-runner";
import { isBelowMinVersion, loadNodeManifest, updateFor, type NodeManifest } from "./manifest";
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
  /** `app` (installato con l'app per Mac), `cli`, null se il nodo non l'ha dichiarato. */
  kind: "app" | "cli" | null;
  pairedAt: Date | null;
  /** IP abbreviato (/24 o /48) da cui è arrivata la richiesta di abbinamento. */
  pairedIp: string | null;
  claude: Record<string, unknown> | null;
  claudeCheckedAt: Date | null;
  gitStatus: { found: boolean; version: string | null } | null;
  settings: NodeSettingsView | null;
  /** Versione proposta dal manifest (solo per i nodi installati con l'app). */
  updateAvailable: string | null;
  updateFailedVersion: string | null;
  /** Versione sotto la minima del protocollo: il server non gli consegna lavoro. */
  belowMinVersion: boolean;
  diagnosticsAt: Date | null;
  diagnosticsRequestedAt: Date | null;
  uninstallRequestedAt: Date | null;
}

export interface NodeSettingsView {
  maxConcurrent: number | null;
  maxConcurrentTurns: number | null;
  taskTimeoutMinutes: number | null;
}

/** Impostazioni salvate in forma normalizzata (null = default del nodo); null se non ce ne sono. */
export function settingsOf(row: Pick<Node, "settings">): NodeSettingsView | null {
  const raw = row.settings;
  if (!raw) return null;
  const pick = (key: string): number | null => (typeof raw[key] === "number" ? (raw[key] as number) : null);
  return { maxConcurrent: pick("maxConcurrent"), maxConcurrentTurns: pick("maxConcurrentTurns"), taskTimeoutMinutes: pick("taskTimeoutMinutes") };
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

export function toNodeView(row: Node, now: Date = new Date(), diagnosticsAt: Date | null = null, manifest: NodeManifest | null = loadNodeManifest()): NodeView {
  const kind = row.kind === "app" || row.kind === "cli" ? row.kind : null;
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
    kind,
    pairedAt: row.pairedAt,
    pairedIp: row.pairedIp,
    claude: row.claudeStatus,
    claudeCheckedAt: row.claudeCheckedAt,
    gitStatus: row.gitStatus ?? null,
    settings: settingsOf(row),
    updateAvailable: updateFor(row.version, kind, manifest, row.updateFailedVersion)?.version ?? null,
    updateFailedVersion: row.updateFailedVersion,
    belowMinVersion: isBelowMinVersion(row.version, manifest),
    diagnosticsAt,
    diagnosticsRequestedAt: row.diagnosticsRequestedAt,
    uninstallRequestedAt: row.uninstallRequestedAt,
  };
}

/** Date delle diagnosi salvate, per id di nodo. */
async function diagnosticsDates(nodeIds: number[]): Promise<Map<number, Date>> {
  if (nodeIds.length === 0) return new Map();
  const rows = await db
    .select({ nodeId: nodeDiagnosticsTable.nodeId, createdAt: nodeDiagnosticsTable.createdAt })
    .from(nodeDiagnosticsTable)
    .where(inArray(nodeDiagnosticsTable.nodeId, nodeIds));
  return new Map(rows.map((r) => [r.nodeId, r.createdAt]));
}

/** Vista del nodo con la data dell'ultima diagnosi (una lettura in più). */
export async function toNodeViewFull(row: Node): Promise<NodeView> {
  return toNodeView(row, new Date(), (await diagnosticsDates([row.id])).get(row.id) ?? null);
}

/** Nome del nodo ripulito; vuoto o troppo lungo lancia `NodeInputError`. */
export function cleanNodeName(name: string): string {
  const clean = name.trim();
  if (clean.length < 1 || clean.length > NAME_MAX) throw new NodeInputError(NODE_MESSAGES.nameInvalid);
  return clean;
}

/** Registra un nodo e il suo token (mostrato una sola volta), in una transazione. */
export async function createNode(userId: number, name: string): Promise<{ node: NodeView; token: string }> {
  const cleanName = cleanNodeName(name);
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
  const manifest = loadNodeManifest();
  const diagnostics = await diagnosticsDates(rows.map((r) => r.id));
  return rows.map((row) => toNodeView(row, now, diagnostics.get(row.id) ?? null, manifest));
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

export interface StoppedWork {
  tasks: TeamTaskRow[];
  turnIds: number[];
}

/** Nella transazione, con la riga del nodo bloccata: ferma compiti e turni del nodo. */
async function stopNodeWork(tx: Tx, nodeId: number): Promise<StoppedWork> {
  return { tasks: await stopNodeTasks(tx, nodeId), turnIds: await failNodeTurns(tx, nodeId) };
}

/** Dopo il commit: attese dei turni risolte; PLAN, evento `bloccato` e turno del capo per ogni compito fermato (un errore non ferma gli altri). */
export async function notifyStopped({ tasks, turnIds }: StoppedWork): Promise<void> {
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
  return toNodeViewFull(out.row);
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
 * Nella transazione, con la riga del nodo già bloccata: revoca i token del nodo e ne ferma compiti e turni in carico
 * (il processo col vecchio token non potrebbe più riferire). Dopo il commit si chiama `notifyStopped`.
 */
export async function revokeNodeTokens(tx: Tx, nodeId: number): Promise<StoppedWork> {
  await tx
    .update(apiTokensTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokensTable.nodeId, nodeId), isNull(apiTokensTable.revokedAt)));
  return stopNodeWork(tx, nodeId);
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
    const stopped = await revokeNodeTokens(tx, id);
    return { token: await createNodeToken(tx, userId, id, `Nodo ${node.name}`), stopped };
  });
  if (!out) return null;
  await notifyStopped(out.stopped);
  return { token: out.token };
}

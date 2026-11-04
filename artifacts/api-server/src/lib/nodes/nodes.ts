// Nodi locali registrati: creazione con token d'ambito `node`, elenco, disattivazione, rigenerazione del
// token ed eliminazione. Un nodo è dell'utente che lo registra; quello di un altro utente non esiste (null).

import { and, asc, eq, isNull } from "drizzle-orm";
import { db, apiTokensTable, nodesTable, type Node } from "@workspace/db";
import { createNodeToken } from "../api-tokens";
import { isUniqueViolation } from "../pg-errors";

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

/** Nodi dell'utente, per nome. */
export async function listNodes(userId: number): Promise<NodeView[]> {
  const rows = await db.select().from(nodesTable).where(eq(nodesTable.userId, userId)).orderBy(asc(nodesTable.name), asc(nodesTable.id));
  const now = new Date();
  return rows.map((row) => toNodeView(row, now));
}

/** Disattiva il nodo (il suo token smette di valere sul protocollo); null se non è dell'utente. */
export async function disableNode(userId: number, id: number): Promise<NodeView | null> {
  const [row] = await db
    .update(nodesTable)
    .set({ status: "disabled", updatedAt: new Date() })
    .where(and(eq(nodesTable.id, id), eq(nodesTable.userId, userId)))
    .returning();
  return row ? toNodeView(row) : null;
}

/** Elimina il nodo e i suoi token (cascade); false se non è dell'utente. */
export async function deleteNode(userId: number, id: number): Promise<boolean> {
  const rows = await db
    .delete(nodesTable)
    .where(and(eq(nodesTable.id, id), eq(nodesTable.userId, userId)))
    .returning({ id: nodesTable.id });
  return rows.length > 0;
}

/** Revoca i token del nodo e ne crea uno nuovo (mostrato una sola volta); null se il nodo non è dell'utente. */
export async function regenerateNodeToken(userId: number, id: number): Promise<{ token: string } | null> {
  return db.transaction(async (tx) => {
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
    return { token: await createNodeToken(tx, userId, id, `Nodo ${node.name}`) };
  });
}

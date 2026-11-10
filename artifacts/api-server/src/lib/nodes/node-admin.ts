// Azioni dell'utente sui suoi nodi dalla console e risposte del nodo: impostazioni, richiesta e invio della diagnosi,
// disinstallazione. Sono un elenco chiuso di azioni che il nodo compie da solo: il server non fa mai eseguire nulla al Mac.
// Un nodo di un altro utente non esiste (null).

import { and, eq, lt } from "drizzle-orm";
import { db, nodeDiagnosticsTable, nodesTable } from "@workspace/db";
import { disableNode, toNodeViewFull, type NodeView } from "./nodes";

export const NODE_ADMIN_MESSAGES = {
  settingsInvalid: "impostazioni del nodo non valide",
} as const;

/** Le diagnosi si tengono 7 giorni. */
export const DIAGNOSTICS_RETENTION_MS = 7 * 86_400_000;

export interface NodeSettingsInput {
  maxConcurrent: number | null;
  maxConcurrentTurns: number | null;
  taskTimeoutMinutes: number | null;
}

const LIMITS = { maxConcurrent: [1, 3], maxConcurrentTurns: [1, 4], taskTimeoutMinutes: [5, 240] } as const;

/** Impostazioni valide: tutti e tre i campi presenti, interi nell'intervallo o null (default del nodo). */
export function parseNodeSettings(input: unknown): NodeSettingsInput | null {
  if (typeof input !== "object" || input === null) return null;
  const out: Record<string, number | null> = {};
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const value = (input as Record<string, unknown>)[key];
    if (value === null) out[key] = null;
    else if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) out[key] = value;
    else return null;
  }
  return out as unknown as NodeSettingsInput;
}

/** Salva le impostazioni (sostituiscono le precedenti); null se il nodo non è dell'utente. */
export async function updateNodeSettings(userId: number, id: number, settings: NodeSettingsInput): Promise<NodeView | null> {
  const [row] = await db
    .update(nodesTable)
    .set({ settings: { ...settings }, updatedAt: new Date() })
    .where(and(eq(nodesTable.id, id), eq(nodesTable.userId, userId)))
    .returning();
  return row ? toNodeViewFull(row) : null;
}

/** Chiede al nodo una diagnosi: la porta al prossimo heartbeat. */
export async function requestNodeDiagnostics(userId: number, id: number): Promise<NodeView | null> {
  const now = new Date();
  const [row] = await db
    .update(nodesTable)
    .set({ diagnosticsRequestedAt: now, updatedAt: now })
    .where(and(eq(nodesTable.id, id), eq(nodesTable.userId, userId)))
    .returning();
  return row ? toNodeViewFull(row) : null;
}

/** Testo dell'ultima diagnosi del nodo; null se il nodo non è dell'utente o non ne ha. */
export async function getNodeDiagnostics(userId: number, id: number): Promise<string | null> {
  const [row] = await db
    .select({ content: nodeDiagnosticsTable.content })
    .from(nodeDiagnosticsTable)
    .innerJoin(nodesTable, eq(nodeDiagnosticsTable.nodeId, nodesTable.id))
    .where(and(eq(nodesTable.id, id), eq(nodesTable.userId, userId)));
  return row?.content ?? null;
}

/** Diagnosi inviata dal nodo: sostituisce la precedente e azzera la richiesta, nella stessa transazione. */
export async function saveNodeDiagnostics(nodeId: number, content: string): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(nodeDiagnosticsTable)
      .values({ nodeId, content, createdAt: now })
      .onConflictDoUpdate({ target: nodeDiagnosticsTable.nodeId, set: { content, createdAt: now } });
    await tx.update(nodesTable).set({ diagnosticsRequestedAt: null, updatedAt: now }).where(eq(nodesTable.id, nodeId));
  });
}

/** Chiede al nodo di disinstallarsi: lo legge con l'heartbeat. */
export async function requestNodeUninstall(userId: number, id: number): Promise<NodeView | null> {
  const now = new Date();
  const [row] = await db
    .update(nodesTable)
    .set({ uninstallRequestedAt: now, updatedAt: now })
    .where(and(eq(nodesTable.id, id), eq(nodesTable.userId, userId)))
    .returning();
  return row ? toNodeViewFull(row) : null;
}

/** Il nodo dice di essersi disinstallato: si disattiva come con «Disattiva» (lavoro in carico fermato). */
export async function markNodeUninstalled(nodeId: number): Promise<void> {
  const [row] = await db.select({ userId: nodesTable.userId }).from(nodesTable).where(eq(nodesTable.id, nodeId));
  if (row) await disableNode(row.userId, nodeId);
}

/** Toglie le diagnosi di oltre 7 giorni; restituisce quante. */
export async function purgeNodeDiagnostics(now: Date = new Date()): Promise<number> {
  const rows = await db
    .delete(nodeDiagnosticsTable)
    .where(lt(nodeDiagnosticsTable.createdAt, new Date(now.getTime() - DIAGNOSTICS_RETENTION_MS)))
    .returning({ nodeId: nodeDiagnosticsTable.nodeId });
  return rows.length;
}

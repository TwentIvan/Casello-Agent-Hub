import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, teamEventsTable, teamInstancesTable, type TeamEventRow } from "@workspace/db";
import type { Executor } from "./skills";

// Eventi della squadra: il bollettino per l'utente che l'ha attivata. Testi troncati ai limiti; nel bollettino e
// nel dettaglio non entrano segreti né indirizzi delle app (chi chiama passa solo testi della squadra).

export const MAX_BULLETIN = 300;
export const MAX_EVENT_DETAIL = 4_000;

export type TeamEventType = TeamEventRow["type"];

export interface EmitEventInput {
  instanceId: number;
  type: TeamEventType;
  taskId?: number | null;
  bulletin: string;
  detail?: string;
}

export async function emitEvent(input: EmitEventInput, executor: Executor = db): Promise<TeamEventRow> {
  const [row] = await executor
    .insert(teamEventsTable)
    .values({
      instanceId: input.instanceId,
      type: input.type,
      taskId: input.taskId ?? null,
      bulletin: input.bulletin.slice(0, MAX_BULLETIN),
      detail: input.detail === undefined ? null : input.detail.slice(0, MAX_EVENT_DETAIL),
    })
    .returning();
  return row!;
}

/** Eventi della squadra, dal più recente; con `unread` solo quelli non letti. */
export async function listEvents(instanceId: number, opts: { unread?: boolean } = {}): Promise<TeamEventRow[]> {
  const conditions = [eq(teamEventsTable.instanceId, instanceId)];
  if (opts.unread) conditions.push(isNull(teamEventsTable.readAt));
  return db
    .select()
    .from(teamEventsTable)
    .where(and(...conditions))
    .orderBy(desc(teamEventsTable.createdAt), desc(teamEventsTable.id));
}

/** Squadre attivate dall'utente (il bollettino è suo). */
function ownedInstances(userId: number) {
  return db.select({ id: teamInstancesTable.id }).from(teamInstancesTable).where(eq(teamInstancesTable.activatedBy, userId));
}

/** Segna letti gli eventi indicati delle squadre attivate dall'utente; restituisce quanti sono cambiati. */
export async function markRead(userId: number, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const updated = await db
    .update(teamEventsTable)
    .set({ readAt: new Date() })
    .where(and(inArray(teamEventsTable.id, ids), isNull(teamEventsTable.readAt), inArray(teamEventsTable.instanceId, ownedInstances(userId))))
    .returning({ id: teamEventsTable.id });
  return updated.length;
}

/** Eventi delle squadre attivate dall'utente, dal più recente (al massimo `limit`); con `unread` solo i non letti. */
export async function userEvents(userId: number, opts: { unread?: boolean; limit?: number } = {}): Promise<TeamEventRow[]> {
  const conditions = [inArray(teamEventsTable.instanceId, ownedInstances(userId))];
  if (opts.unread) conditions.push(isNull(teamEventsTable.readAt));
  const query = db
    .select()
    .from(teamEventsTable)
    .where(and(...conditions))
    .orderBy(desc(teamEventsTable.createdAt), desc(teamEventsTable.id));
  return opts.limit === undefined ? query : query.limit(opts.limit);
}

/** Eventi non letti delle squadre attivate dall'utente, dal più recente. */
export async function unreadBulletin(userId: number): Promise<TeamEventRow[]> {
  return userEvents(userId, { unread: true });
}

// Controlli periodici dei compiti dei nodi (ogni minuto e all'avvio): lease scadute → compito `failed` («nodo non
// più raggiungibile») con evento e turno del capo; compiti in attesa da oltre 10 minuti senza alcun nodo vivo
// adatto → evento `bloccato` una sola volta per compito (`no_node_notified`), il compito resta in attesa; compiti in
// attesa di squadre oltre il tetto di spesa → `blocked` (come al claim: il nodo non chiede il claim se `pending` è 0).

import { and, eq, gte, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db, nodesTable, teamInstancesTable, teamTasksTable } from "@workspace/db";
import { logger } from "../logger";
import { purgeDeletedAttachments } from "../teams/attachments";
import { emitEvent } from "../teams/events";
import { InstanceRoleSchema } from "../teams/manifest";
import { errName, finishTaskExecution } from "../teams/task-runner";
import { NODE_ONLINE_WINDOW_MS } from "./nodes";
import { teamCapBlock } from "../teams/team-budget";
import { blockCappedTask, hasSkills, roleNodeSkills } from "./protocol";

export const SWEEP_INTERVAL_MS = 60_000;
/** Attesa oltre la quale un compito senza nodo adatto si segnala. */
export const NODELESS_AFTER_MS = 10 * 60_000;

export const SWEEP_MESSAGES = {
  unreachable: "nodo non più raggiungibile",
  roleMissing: (key: string) => `ruolo ${key} non più nella squadra`,
  noNode: (skills: string[]) => `nessun nodo disponibile con le skill: ${skills.length > 0 ? skills.join(", ") : "(nessuna)"}`,
} as const;

/** Compiti `running` con lease scaduta a `now` → `failed`; restituisce quanti ne ha chiusi. */
export async function sweepExpiredLeases(now: Date = new Date()): Promise<number> {
  const expired = await db
    .select()
    .from(teamTasksTable)
    .where(and(eq(teamTasksTable.status, "running"), isNotNull(teamTasksTable.leaseToken), lte(teamTasksTable.leaseExpiresAt, now)));
  let closed = 0;
  for (const task of expired) {
    try {
      // Condizionato alla stessa lease ancora scaduta: un report o un ping arrivati nel frattempo vincono
      const done = await finishTaskExecution(
        task,
        { status: "failed", outcome: SWEEP_MESSAGES.unreachable, error: SWEEP_MESSAGES.unreachable },
        { promptTokens: null, completionTokens: null, costUsd: null },
        { kind: "expired", leaseToken: task.leaseToken!, now },
      );
      if (done) closed++;
    } catch (err) {
      logger.error({ teamTaskId: task.id, errName: errName(err) }, "Chiusura del compito con lease scaduta non riuscita");
    }
  }
  return closed;
}

/**
 * Compiti `waiting_node` di squadre attive oltre il tetto di spesa → `blocked` «tetto di spesa della squadra
 * raggiunto» (PLAN, evento `bloccato`, turno del capo), una volta sola (UPDATE condizionato a `waiting_node`).
 * Restituisce quanti ne ha chiusi.
 */
export async function blockCappedWaitingTasks(): Promise<number> {
  const waiting = await db
    .select({ task: teamTasksTable })
    .from(teamTasksTable)
    .innerJoin(teamInstancesTable, eq(teamTasksTable.instanceId, teamInstancesTable.id))
    .where(and(eq(teamTasksTable.status, "waiting_node"), eq(teamInstancesTable.status, "active"), isNotNull(teamInstancesTable.monthlyBudgetUsd)));
  const capped = new Map<number, boolean>();
  let blocked = 0;
  for (const { task } of waiting) {
    try {
      if (!capped.has(task.instanceId)) capped.set(task.instanceId, (await teamCapBlock(task.instanceId)) !== null);
      if (capped.get(task.instanceId) && (await blockCappedTask(task))) blocked++;
    } catch (err) {
      logger.error({ teamTaskId: task.id, errName: errName(err) }, "Controllo del tetto del compito del nodo non riuscito");
    }
  }
  return blocked;
}

/** Segnala (una volta) i compiti in attesa da oltre 10 minuti senza un nodo vivo dell'utente con le skill del ruolo. */
export async function notifyNodelessTasks(now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - NODELESS_AFTER_MS);
  const waiting = await db
    .select({ task: teamTasksTable, instance: teamInstancesTable })
    .from(teamTasksTable)
    .innerJoin(teamInstancesTable, eq(teamTasksTable.instanceId, teamInstancesTable.id))
    .where(
      and(
        eq(teamTasksTable.status, "waiting_node"),
        eq(teamTasksTable.noNodeNotified, false),
        // Confronti sulle colonne (non su un'espressione): la data passa dalla conversione della colonna, in UTC
        or(lte(teamTasksTable.waitingSince, since), and(isNull(teamTasksTable.waitingSince), lte(teamTasksTable.createdAt, since))),
        eq(teamInstancesTable.status, "active"),
        isNotNull(teamInstancesTable.activatedBy),
      ),
    );

  const liveByUser = new Map<number, string[][]>();
  let notified = 0;
  for (const { task, instance } of waiting) {
    try {
      const userId = instance.activatedBy!;
      let live = liveByUser.get(userId);
      if (!live) {
        const rows = await db
          .select({ skills: nodesTable.skills })
          .from(nodesTable)
          .where(and(eq(nodesTable.userId, userId), eq(nodesTable.status, "active"), gte(nodesTable.lastSeenAt, new Date(now.getTime() - NODE_ONLINE_WINDOW_MS))));
        live = rows.map((r) => r.skills);
        liveByUser.set(userId, live);
      }
      const role = InstanceRoleSchema.array().parse(instance.roles).find((r) => r.key === task.roleKey);
      const required = role ? await roleNodeSkills(instance.id, role) : [];
      if (role && live.some((skills) => hasSkills(skills, required))) continue;

      const message = role ? SWEEP_MESSAGES.noNode(required) : SWEEP_MESSAGES.roleMissing(task.roleKey);
      const emitted = await db.transaction(async (tx) => {
        const [marked] = await tx
          .update(teamTasksTable)
          .set({ noNodeNotified: true })
          .where(and(eq(teamTasksTable.id, task.id), eq(teamTasksTable.status, "waiting_node"), eq(teamTasksTable.noNodeNotified, false)))
          .returning({ id: teamTasksTable.id });
        if (!marked) return false;
        await emitEvent({ instanceId: instance.id, type: "bloccato", taskId: task.id, bulletin: `Compito ${task.planTaskId} (${task.roleKey}): ${message}` }, tx);
        return true;
      });
      if (emitted) notified++;
    } catch (err) {
      logger.error({ teamTaskId: task.id, errName: errName(err) }, "Segnalazione del compito senza nodo non riuscita");
    }
  }
  return notified;
}

/** Avvio del processo dell'API: prima di NODE_ONLINE_WINDOW_MS i nodi sembrano spenti solo perché l'API era giù. */
const PROCESS_STARTED_AT = new Date();

/**
 * Un giro dei controlli; un errore si registra (solo il tipo), mai come promise rifiutata. L'avviso «nessun nodo»
 * aspetta che l'API sia su da almeno NODE_ONLINE_WINDOW_MS (`upSince`), così i nodi hanno avuto modo di farsi vivi.
 */
export async function sweepNodeTasks(now: Date = new Date(), upSince: Date = PROCESS_STARTED_AT): Promise<void> {
  try {
    const expired = await sweepExpiredLeases(now);
    if (expired > 0) logger.warn({ count: expired }, "Compiti dei nodi chiusi per lease scaduta");
  } catch (err) {
    logger.error({ errName: errName(err) }, "Controllo delle lease dei nodi non riuscito");
  }
  try {
    const blocked = await blockCappedWaitingTasks();
    if (blocked > 0) logger.warn({ count: blocked }, "Compiti dei nodi bloccati dal tetto di spesa della squadra");
  } catch (err) {
    logger.error({ errName: errName(err) }, "Controllo del tetto dei compiti dei nodi non riuscito");
  }
  try {
    await purgeDeletedAttachments();
  } catch (err) {
    logger.error({ errName: errName(err) }, "Pulizia degli allegati eliminati non riuscita");
  }
  if (now.getTime() - upSince.getTime() < NODE_ONLINE_WINDOW_MS) return;
  try {
    await notifyNodelessTasks(now);
  } catch (err) {
    logger.error({ errName: errName(err) }, "Controllo dei compiti senza nodo non riuscito");
  }
}

/** Avvia il controllo ogni minuto (il timer non tiene vivo il processo); restituisce la funzione per fermarlo. */
export function startNodeSweeper(): () => void {
  const timer = setInterval(() => void sweepNodeTasks(), SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

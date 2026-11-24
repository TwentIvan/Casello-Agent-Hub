import { db, agentsTable, agentTriggersTable, type AgentTrigger } from "@workspace/db";
import { and, eq, lte, sql } from "drizzle-orm";
import { logger } from "../logger";
import { runBudgetBlock } from "../budget";
import { scheduleRuns } from "../run-queue";
import { formatLocal, nextCronTime, parseCron } from "./cron";
import { buildScheduleInput } from "./input";
import { TRIGGER_MESSAGES } from "./messages";
import { isActive, lockActive, NotActive, QueueFull, queueTriggerRun } from "./queue-run";

// Run programmate (issue #107): a ogni scadenza dell'espressione cron di un innesco `schedule` si mette in coda una
// run dell'agente, come `POST /agents/:id/runs` (coda, limiti e tetti di sempre). Nessun utente né token utente: i tool
// con identità `user` rispondono «token utente mancante», le azioni L2 vanno in «Da confermare» come per ogni run.
// Una scadenza persa (server fermo, tetto, coda piena, agente non attivo) non si recupera: vale la successiva.

/** Errori di fila dopo i quali l'innesco passa in `error` (come la sorveglianza). */
const MAX_CONSECUTIVE_ERRORS = 10;

export type ScheduleOutcome = "skipped" | { runId: number } | { error: string };

/** Esito finale della scadenza, solo se l'innesco è ancora attivo con lo stesso orario. */
async function finish(trigger: AgentTrigger, set: Partial<typeof agentTriggersTable.$inferInsert>): Promise<void> {
  await db
    .update(agentTriggersTable)
    .set({ ...set, lastPolledAt: new Date(), updatedAt: new Date() })
    .where(and(isActive(trigger.id), eq(agentTriggersTable.cron, trigger.cron!)));
}

/**
 * Una scadenza della run programmata. Presa in carico condizionata alla scadenza letta (una sola run per scadenza anche
 * con più container), che sposta subito `next_poll_at` all'occorrenza successiva. Non lancia.
 */
export async function fireSchedule(triggerId: number, now: Date = new Date()): Promise<ScheduleOutcome> {
  const [due] = await db
    .select()
    .from(agentTriggersTable)
    .where(and(isActive(triggerId), eq(agentTriggersTable.kind, "schedule"), lte(agentTriggersTable.nextPollAt, sql`now()`)))
    .limit(1);
  if (!due || due.cron === null || due.nextPollAt === null) return "skipped";
  const spec = parseCron(due.cron);
  // Mai prima della scadenza letta: con un orologio in ritardo la scadenza non si ripete.
  const after = now.getTime() > due.nextPollAt.getTime() ? now : due.nextPollAt;
  const next = spec ? nextCronTime(spec, after) : null;
  if (!spec || !next) {
    // Un'espressione salvata è sempre valida: qui solo per sicurezza, l'innesco si ferma.
    await db
      .update(agentTriggersTable)
      .set({ status: "error", lastError: TRIGGER_MESSAGES.invalidCron, updatedAt: new Date() })
      .where(isActive(triggerId));
    return { error: TRIGGER_MESSAGES.invalidCron };
  }
  const [trigger] = await db
    .update(agentTriggersTable)
    .set({ nextPollAt: next, updatedAt: new Date() })
    .where(
      and(isActive(triggerId), eq(agentTriggersTable.cron, due.cron), eq(agentTriggersTable.nextPollAt, due.nextPollAt)),
    )
    .returning();
  if (!trigger) return "skipped";

  try {
    return await queueScheduledRun(trigger, due.nextPollAt);
  } catch (err) {
    logger.error({ triggerId, errName: err instanceof Error ? err.name : typeof err }, "Run programmata non avviata");
    const errors = sql`${agentTriggersTable.consecutiveErrors} + 1`;
    await db
      .update(agentTriggersTable)
      .set({
        consecutiveErrors: errors,
        lastError: TRIGGER_MESSAGES.pollFailed,
        status: sql`case when ${errors} >= ${MAX_CONSECUTIVE_ERRORS} then 'error'::trigger_status else ${agentTriggersTable.status} end`,
        lastPolledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(isActive(trigger.id), eq(agentTriggersTable.cron, trigger.cron!)));
    return { error: TRIGGER_MESSAGES.pollFailed };
  }
}

async function queueScheduledRun(trigger: AgentTrigger, scheduledFor: Date): Promise<ScheduleOutcome> {
  const id = trigger.id;
  // Agente non attivo o senza modello: scadenza saltata senza errore, come la sorveglianza.
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, trigger.agentId)).limit(1);
  if (!agent || agent.status !== "active" || agent.aiModelId === null) return "skipped";

  if (await runBudgetBlock(agent)) {
    await finish(trigger, { lastError: TRIGGER_MESSAGES.budgetWait });
    logger.info({ triggerId: id, outcome: "budget" }, "Run programmata saltata: tetto di spesa");
    return "skipped";
  }

  const runInput = buildScheduleInput({
    name: trigger.name,
    instructions: trigger.instructions ?? "",
    scheduledFor: formatLocal(scheduledFor),
  });
  let runId: number | null;
  try {
    runId = await db.transaction(async (tx) => {
      await lockActive(tx, id, eq(agentTriggersTable.cron, trigger.cron!));
      return queueTriggerRun(tx, { trigger, agent, key: null, runInput });
    });
  } catch (err) {
    if (err instanceof NotActive) return "skipped";
    if (err instanceof QueueFull) {
      await finish(trigger, { lastError: TRIGGER_MESSAGES.queueFull });
      logger.info({ triggerId: id, outcome: "queue_full" }, "Run programmata saltata: coda piena");
      return "skipped";
    }
    throw err;
  }
  await finish(trigger, { consecutiveErrors: 0, lastError: null });
  void scheduleRuns();
  logger.info({ triggerId: id, runId, outcome: "ok" }, "Run programmata in coda");
  return { runId: runId! };
}

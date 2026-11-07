import {
  db,
  agentsTable,
  agentTriggersTable,
  appToolsTable,
  triggerSeenItemsTable,
  type Agent,
  type AgentTrigger,
} from "@workspace/db";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { logger } from "../logger";
import { runBudgetBlock } from "../budget";
import { createQueuedRun, scheduleRuns } from "../run-queue";
import { executeTool } from "../tools/executor";
import { loadAppConnection, toCatalogTool } from "../tools/catalog";
import type { CatalogTool, DbTransaction as Tx } from "../tools/types";
import { toolUsableByTrigger } from "./eligibility";
import { compareCursor, extractItems, type ExtractedItem } from "./extract";
import { buildTriggerInput } from "./input";
import { TRIGGER_MESSAGES } from "./messages";

// Sorveglianza (spec §4.3): un giro chiama il tool dell'innesco, estrae gli elementi e crea una run per
// ogni elemento nuovo. La chiave dell'elemento e la run stanno nella stessa transazione: una chiave vista
// non diventa mai una seconda run, una run non creata non lascia la chiave. Ogni UPDATE finale è
// condizionato a `status = 'active'`: un innesco messo in pausa o eliminato a giro in corso resta com'è.

/** Run create al più in un giro: le altre chiavi nuove restano per il giro dopo, che parte subito. */
export const MAX_RUNS_PER_PASS = 20;
/** Errori di fila dopo i quali l'innesco passa in `error` e i giri si fermano. */
export const MAX_CONSECUTIVE_ERRORS = 10;
const MAX_BACKOFF_SECONDS = 3600;
const POLL_CHECK_MS = 15_000;
const DUE_PER_CHECK = 20;
const PARALLEL_POLLS = 4;
const SWEEP_MS = 60 * 60 * 1000;
const SEEN_RETENTION_DAYS = 30;
const MAX_SEEN_PER_TRIGGER = 10_000;
/** Testo che il tool restituisce per un risultato vuoto (MCP o HTTP senza corpo). */
const EMPTY_RESULT = "(risposta vuota)";

export type PollOutcome = "skipped" | "baseline" | { created: number; more: boolean } | { error: string };

/** Sentinella: coda delle run piena, annulla la transazione dell'elemento e ferma il giro. */
class QueueFull extends Error {}
/** Sentinella: innesco non più attivo (pausa o eliminazione a giro in corso), annulla e ferma il giro. */
class NotActive extends Error {}

const isActive = (id: number) => and(eq(agentTriggersTable.id, id), eq(agentTriggersTable.status, "active"));

/** Errore del giro: conta, rimanda con backoff e dopo 10 di fila ferma l'innesco. */
async function recordError(id: number, message: string, stop = false): Promise<PollOutcome> {
  const next = sql`${agentTriggersTable.consecutiveErrors} + 1`;
  await db
    .update(agentTriggersTable)
    .set({
      consecutiveErrors: next,
      lastError: message,
      lastPolledAt: new Date(),
      nextPollAt: sql`now() + least(${agentTriggersTable.intervalSeconds} * power(2, least(${next}, 20)), ${MAX_BACKOFF_SECONDS}) * interval '1 second'`,
      status: stop
        ? sql`'error'::trigger_status`
        : sql`case when ${next} >= ${MAX_CONSECUTIVE_ERRORS} then 'error'::trigger_status else ${agentTriggersTable.status} end`,
      updatedAt: new Date(),
    })
    .where(isActive(id));
  logger.info({ triggerId: id, outcome: "error" }, "Giro dell'innesco non riuscito");
  return { error: message };
}

/** Valore da passare come argomento del cursore: numero se lo schema del parametro lo chiede. */
function cursorArg(tool: CatalogTool, param: string, value: string): string | number {
  const props = tool.paramsSchema["properties"];
  const prop = props && typeof props === "object" ? (props as Record<string, unknown>)[param] : undefined;
  const type = prop && typeof prop === "object" ? (prop as Record<string, unknown>)["type"] : undefined;
  if ((type === "number" || type === "integer") && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

/**
 * Nuovo valore del cursore (spec §4.3 punto 8): il più alto tra gli elementi elaborati (chiavi inserite),
 * mai oltre un elemento rimasto per il giro dopo (strettamente sotto il più basso di quelli), mai all'indietro.
 */
function nextCursor(stored: string | null, processed: ExtractedItem[], left: ExtractedItem[]): string | null {
  let floor: string | number | null = null;
  for (const item of left) {
    // Un elemento rimasto senza cursore: non si sa dove sta, il cursore non avanza.
    if (item.cursor === null) return stored;
    if (floor === null || compareCursor(item.cursor, floor) < 0) floor = item.cursor;
  }
  let best: string | number | null = null;
  for (const item of processed) {
    if (item.cursor === null) continue;
    if (floor !== null && compareCursor(item.cursor, floor) >= 0) continue;
    if (best === null || compareCursor(item.cursor, best) > 0) best = item.cursor;
  }
  if (best === null) return stored;
  if (stored !== null) {
    const typedStored = typeof best === "number" && Number.isFinite(Number(stored)) && stored.trim() !== "" ? Number(stored) : stored;
    if (compareCursor(typedStored, best) >= 0) return stored;
  }
  return String(best);
}

/** Elementi senza chiavi ripetute, nell'ordine della risposta. */
function uniqueByKey(items: ExtractedItem[]): ExtractedItem[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
}

/** Blocca la riga dell'innesco se è ancora attivo; altrimenti la transazione si annulla. */
async function lockActive(tx: Tx, id: number): Promise<void> {
  const [row] = await tx.select({ id: agentTriggersTable.id }).from(agentTriggersTable).where(isActive(id)).for("update");
  if (!row) throw new NotActive();
}

/** Un giro dell'innesco. Non lancia: gli errori diventano l'esito `{error}` sull'innesco. */
export async function pollTrigger(triggerId: number, deps: { fetchImpl?: typeof fetch } = {}): Promise<PollOutcome> {
  // 1. Presa in carico condizionata: un giro alla volta per innesco.
  const [trigger] = await db
    .update(agentTriggersTable)
    .set({
      nextPollAt: sql`now() + ${agentTriggersTable.intervalSeconds} * interval '1 second'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        isActive(triggerId),
        eq(agentTriggersTable.kind, "poll"),
        lte(agentTriggersTable.nextPollAt, sql`now()`),
      ),
    )
    .returning();
  if (!trigger) return "skipped";

  try {
    return await runPass(trigger, deps);
  } catch (err) {
    logger.error({ triggerId, errName: err instanceof Error ? err.name : typeof err }, "Giro dell'innesco interrotto");
    return recordError(triggerId, TRIGGER_MESSAGES.pollFailed);
  }
}

async function runPass(trigger: AgentTrigger, deps: { fetchImpl?: typeof fetch }): Promise<PollOutcome> {
  const id = trigger.id;

  // 2. Agente non attivo o senza modello: si salta senza errore, si riprova all'intervallo.
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, trigger.agentId)).limit(1);
  if (!agent || agent.status !== "active" || agent.aiModelId === null) return "skipped";

  // Tool ancora idoneo (spec §4.1): altrimenti l'innesco si ferma in `error`.
  const [toolRow] = trigger.toolId === null
    ? []
    : await db.select().from(appToolsTable).where(eq(appToolsTable.id, trigger.toolId)).limit(1);
  const tool = toolRow && toolUsableByTrigger(toolRow, agent.appId) ? toCatalogTool(toolRow) : null;
  if (!tool) return recordError(id, TRIGGER_MESSAGES.toolNoLonger, true);

  // 3. Tetti di spesa: il giro salta senza segnare nulla e senza contare come errore.
  if (await runBudgetBlock(agent)) {
    await db
      .update(agentTriggersTable)
      .set({ lastError: TRIGGER_MESSAGES.budgetWait, updatedAt: new Date() })
      .where(isActive(id));
    logger.info({ triggerId: id, outcome: "budget" }, "Giro dell'innesco rimandato: tetto di spesa");
    return "skipped";
  }

  // 4. Chiamata del tool con gli argomenti fissi e il cursore.
  const baseArgs = trigger.args && typeof trigger.args === "object" && !Array.isArray(trigger.args) ? trigger.args : {};
  const args: Record<string, unknown> = { ...(baseArgs as Record<string, unknown>) };
  if (trigger.cursorParam && trigger.cursorValue !== null) {
    args[trigger.cursorParam] = cursorArg(tool, trigger.cursorParam, trigger.cursorValue);
  }
  const conn = await loadAppConnection(agent.appId);
  const result = await executeTool({
    conn,
    tool,
    args,
    raw: true,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (!result.ok) {
    // Mai il testo della risposta: può contenere dati o segreti dell'app.
    const message = result.status !== undefined ? `${TRIGGER_MESSAGES.toolFailed} (HTTP ${result.status})` : TRIGGER_MESSAGES.toolFailed;
    return recordError(id, message);
  }
  if (result.content === EMPTY_RESULT) return recordError(id, TRIGGER_MESSAGES.unrecognized);
  let response: unknown;
  try {
    response = JSON.parse(result.content);
  } catch {
    return recordError(id, TRIGGER_MESSAGES.unrecognized);
  }

  // 5. Estrazione.
  const extracted = extractItems(response, {
    itemsPath: trigger.itemsPath,
    idField: trigger.idField ?? "id",
    versionField: trigger.versionField,
    cursorField: trigger.cursorField,
    filter: (trigger.filter as { field: string; equals: string | number | boolean } | null) ?? null,
  });
  if (!extracted.ok) return recordError(id, TRIGGER_MESSAGES.listNotFound);
  const items = uniqueByKey(extracted.items);

  // 6. Linea di partenza: tutte le chiavi viste, nessuna run.
  if (!trigger.baselineDone) {
    try {
      await db.transaction(async (tx) => {
        await lockActive(tx, id);
        if (items.length > 0) {
          await tx
            .insert(triggerSeenItemsTable)
            .values(items.map((i) => ({ triggerId: id, itemKey: i.key })))
            .onConflictDoNothing();
        }
        await tx
          .update(agentTriggersTable)
          .set({
            baselineDone: true,
            cursorValue: nextCursor(trigger.cursorValue, items, []),
            lastPolledAt: new Date(),
            consecutiveErrors: 0,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(isActive(id));
      });
    } catch (err) {
      if (err instanceof NotActive) return "skipped";
      throw err;
    }
    logger.info({ triggerId: id, outcome: "baseline", items: items.length, skipped: extracted.skipped }, "Linea di partenza dell'innesco");
    return "baseline";
  }

  // 7. Elementi nuovi, nell'ordine della risposta, al più 20 per giro.
  const known = new Set<string>();
  if (items.length > 0) {
    const rows = await db
      .select({ key: triggerSeenItemsTable.itemKey })
      .from(triggerSeenItemsTable)
      .where(
        and(
          eq(triggerSeenItemsTable.triggerId, id),
          inArray(
            triggerSeenItemsTable.itemKey,
            items.map((i) => i.key),
          ),
        ),
      );
    for (const r of rows) known.add(r.key);
  }
  const fresh = items.filter((i) => !known.has(i.key));
  const batch = fresh.slice(0, MAX_RUNS_PER_PASS);

  const processed: ExtractedItem[] = [];
  let created = 0;
  let stoppedAt: number | null = null;
  let queueFull = false;
  for (let index = 0; index < batch.length; index++) {
    const item = batch[index]!;
    try {
      const made = await db.transaction(async (tx) => createRunForItem(tx, trigger, agent, item));
      processed.push(item);
      if (made) created += 1;
    } catch (err) {
      if (err instanceof QueueFull) {
        queueFull = true;
        stoppedAt = index;
        break;
      }
      if (err instanceof NotActive) {
        stoppedAt = index;
        break;
      }
      throw err;
    }
  }
  if (created > 0) void scheduleRuns();

  const stopped = stoppedAt !== null;
  const left = stopped ? fresh.slice(stoppedAt!) : fresh.slice(MAX_RUNS_PER_PASS);
  const more = !stopped && left.length > 0;

  // 8-9. Cursore ed esito, solo se l'innesco è ancora attivo.
  await db
    .update(agentTriggersTable)
    .set({
      cursorValue: nextCursor(trigger.cursorValue, processed, left),
      lastPolledAt: new Date(),
      consecutiveErrors: 0,
      lastError: queueFull ? TRIGGER_MESSAGES.queueFull : null,
      ...(more ? { nextPollAt: sql`now()` } : {}),
      updatedAt: new Date(),
    })
    .where(isActive(id));

  logger.info(
    { triggerId: id, outcome: queueFull ? "queue_full" : "ok", created, left: left.length, skipped: extracted.skipped },
    "Giro dell'innesco",
  );
  return { created, more };
}

/**
 * Transazione di un elemento: innesco ancora attivo (riga bloccata), chiave inserita e, solo se la riga è
 * nuova, run in coda e contatore. Coda piena → QueueFull annulla tutto, chiave compresa.
 */
async function createRunForItem(tx: Tx, trigger: AgentTrigger, agent: Agent, item: ExtractedItem): Promise<boolean> {
  await lockActive(tx, trigger.id);
  const inserted = await tx
    .insert(triggerSeenItemsTable)
    .values({ triggerId: trigger.id, itemKey: item.key })
    .onConflictDoNothing()
    .returning({ key: triggerSeenItemsTable.itemKey });
  if (inserted.length === 0) return false;
  const queued = await createQueuedRun({
    agent,
    input: buildTriggerInput({ kind: "poll", name: trigger.name, instructions: trigger.instructions, content: item.value }),
    triggerId: trigger.id,
    tx,
  });
  if (!queued.ok) throw new QueueFull();
  await tx
    .update(agentTriggersTable)
    .set({ runsCreated: sql`${agentTriggersTable.runsCreated} + 1` })
    .where(eq(agentTriggersTable.id, trigger.id));
  return true;
}

/** Inneschi scaduti, fino a 20, eseguiti con al più 4 giri in parallelo. */
async function pollDueTriggers(): Promise<void> {
  const due = await db
    .select({ id: agentTriggersTable.id })
    .from(agentTriggersTable)
    .where(
      and(
        eq(agentTriggersTable.status, "active"),
        eq(agentTriggersTable.kind, "poll"),
        lte(agentTriggersTable.nextPollAt, sql`now()`),
      ),
    )
    .orderBy(asc(agentTriggersTable.nextPollAt))
    .limit(DUE_PER_CHECK);
  const queue = due.map((d) => d.id);
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      await pollTrigger(id).catch((err: unknown) => {
        logger.error({ triggerId: id, errName: err instanceof Error ? err.name : typeof err }, "Giro dell'innesco non riuscito");
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_POLLS, queue.length) }, worker));
}

/** Pulizia delle chiavi viste: oltre 30 giorni, e oltre 10 000 per innesco le più vecchie. */
export async function sweepSeenItems(): Promise<void> {
  const old = await db.execute(sql`
    delete from trigger_seen_items where seen_at < now() - ${SEEN_RETENTION_DAYS} * interval '1 day'`);
  const extra = await db.execute(sql`
    delete from trigger_seen_items t
     using (
       select trigger_id, item_key from (
         select trigger_id, item_key,
                row_number() over (partition by trigger_id order by seen_at desc, item_key desc) as position
           from trigger_seen_items
       ) ranked
        where position > ${MAX_SEEN_PER_TRIGGER}
     ) d
     where t.trigger_id = d.trigger_id and t.item_key = d.item_key`);
  const removed = (old.rowCount ?? 0) + (extra.rowCount ?? 0);
  if (removed > 0) logger.info({ removed }, "Chiavi viste degli inneschi tolte");
}

/**
 * Avvia la sorveglianza: un controllo ogni 15 s (uno alla volta) e la pulizia delle chiavi ogni ora.
 * Restituisce la funzione che la ferma. Nessun recupero all'avvio: lo stato sta tutto nel DB.
 */
export function startTriggerPoller(): () => void {
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      await pollDueTriggers();
    } catch (err) {
      logger.error({ errName: err instanceof Error ? err.name : typeof err }, "Controllo degli inneschi non riuscito");
    } finally {
      checking = false;
    }
  };
  const sweep = () =>
    sweepSeenItems().catch((err: unknown) =>
      logger.error({ errName: err instanceof Error ? err.name : typeof err }, "Pulizia delle chiavi viste non riuscita"),
    );
  const pollTimer = setInterval(() => void check(), POLL_CHECK_MS);
  const sweepTimer = setInterval(() => void sweep(), SWEEP_MS);
  pollTimer.unref();
  sweepTimer.unref();
  return () => {
    clearInterval(pollTimer);
    clearInterval(sweepTimer);
  };
}

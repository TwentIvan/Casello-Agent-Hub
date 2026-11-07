import { db, runsTable, type Agent, type Run } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { USER_TOKEN_LOST, startRun } from "./run-executor";
import { setUserToken } from "./user-tokens";

// Coda delle run: il POST crea la run `pending`, lo scheduler di questo processo la avvia quando c'è posto.
// Limiti di concorrenza per agente e in totale; le run aspettano in ordine di creazione (created_at, id).
// La presa in carico resta l'UPDATE condizionato `pending` → `running` di startRun: ogni run gira una volta.

export const MAX_RUNNING_PER_AGENT = 2;
export const MAX_RUNNING_RUNS = 6;
export const MAX_PENDING_PER_AGENT = 200;
/** Controllo di riserva dello scheduler (oltre a creazione e fine di ogni run). */
const SCHEDULE_INTERVAL_MS = 30_000;

export const RUN_QUEUE_MESSAGES = {
  queueFull: "troppe run in attesa per questo agente",
  userTokenLost: USER_TOKEN_LOST,
} as const;

export type CreateQueuedRunResult = { ok: true; run: Run } | { ok: false; reason: "queue_full" };

/**
 * Crea una run `pending` dell'agente con il suo modello (chi paga resta chi pagava alla creazione) e la
 * mette in coda. Il token dell'utente va solo in memoria; `has_user_token` ricorda che c'era, perché al
 * riavvio quella run non può ripartire. Coda piena (MAX_PENDING_PER_AGENT) → nessuna riga inserita.
 */
export async function createQueuedRun(input: {
  agent: Agent;
  input: string | null;
  parentRunId?: number | null;
  userToken?: string;
}): Promise<CreateQueuedRunResult> {
  const { agent, userToken } = input;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runsTable)
    .where(and(eq(runsTable.agentId, agent.id), eq(runsTable.status, "pending")));
  if (Number(row?.count ?? 0) >= MAX_PENDING_PER_AGENT) return { ok: false, reason: "queue_full" };

  const [run] = await db
    .insert(runsTable)
    .values({
      agentId: agent.id,
      aiModelId: agent.aiModelId,
      status: "pending",
      input: input.input,
      parentRunId: input.parentRunId ?? null,
      hasUserToken: Boolean(userToken),
    })
    .returning();
  if (userToken) setUserToken(run!.id, userToken);
  void scheduleRuns();
  return { ok: true, run: run! };
}

// Run avviate da questo processo e non ancora finite (id → agente). Contano come `running` anche prima
// che startRun abbia scritto lo stato, così un giro successivo non le riavvia né sfora i limiti.
const launched = new Map<number, number>();

// Un giro alla volta: una chiamata durante un giro ne programma esattamente un altro, subito dopo.
let currentLoop: Promise<void> | null = null;
let rerunRequested = false;

/** Avvia le run in attesa che stanno nei limiti. Non lancia: gli errori finiscono nel log. */
export function scheduleRuns(): Promise<void> {
  if (currentLoop) {
    rerunRequested = true;
    return currentLoop;
  }
  currentLoop = (async () => {
    try {
      do {
        rerunRequested = false;
        try {
          await schedulePass();
        } catch (err) {
          logger.error({ errName: err instanceof Error ? err.name : typeof err }, "Giro dello scheduler delle run non riuscito");
        }
      } while (rerunRequested);
    } finally {
      currentLoop = null;
    }
  })();
  return currentLoop;
}

async function schedulePass(): Promise<void> {
  const busy = new Map<number, number>(launched);
  const running = await db
    .select({ id: runsTable.id, agentId: runsTable.agentId })
    .from(runsTable)
    .where(eq(runsTable.status, "running"));
  for (const r of running) busy.set(r.id, r.agentId);
  if (busy.size >= MAX_RUNNING_RUNS) return;

  const perAgent = new Map<number, number>();
  for (const agentId of busy.values()) perAgent.set(agentId, (perAgent.get(agentId) ?? 0) + 1);

  // Per ogni agente bastano le prime MAX_RUNNING_PER_AGENT in attesa: quelle già avviate da qui ma ancora
  // `pending` nel DB occupano un posto dell'agente. L'elenco resta piccolo anche con molte run in coda.
  const candidates = await db.execute<{ id: number; agent_id: number }>(sql`
    select id, agent_id from (
      select id, agent_id, created_at,
             row_number() over (partition by agent_id order by created_at, id) as position
        from runs
       where status = 'pending'
    ) queued
     where position <= ${MAX_RUNNING_PER_AGENT}
     order by created_at, id`);

  let total = busy.size;
  for (const c of candidates.rows) {
    if (total >= MAX_RUNNING_RUNS) break;
    const id = Number(c.id);
    const agentId = Number(c.agent_id);
    if (busy.has(id)) continue;
    if ((perAgent.get(agentId) ?? 0) >= MAX_RUNNING_PER_AGENT) continue;
    busy.set(id, agentId);
    perAgent.set(agentId, (perAgent.get(agentId) ?? 0) + 1);
    total++;
    launch(id, agentId);
  }
}

function launch(runId: number, agentId: number): void {
  launched.set(runId, agentId);
  startRun(runId)
    .catch((err: unknown) =>
      logger.error({ runId, errName: err instanceof Error ? err.name : typeof err }, "Esecuzione della run fallita"),
    )
    .finally(() => {
      launched.delete(runId);
      void scheduleRuns();
    });
}

/** Avvia lo scheduler: un giro subito, poi uno ogni 30 s di riserva. Restituisce la funzione che lo ferma. */
export function startRunQueue(): () => void {
  void scheduleRuns();
  const timer = setInterval(() => void scheduleRuns(), SCHEDULE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

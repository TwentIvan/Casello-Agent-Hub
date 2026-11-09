import { and, asc, eq, gte, inArray, isNotNull, like, lt, sql } from "drizzle-orm";
import { db, agentsTable, aiAccountsTable, aiModelsTable, appsTable, pendingActionsTable, runsTable, teamInstancesTable } from "@workspace/db";
import { LEAD_INPUT_MARKER } from "../product-leads";
import { AlfredError } from "./gemini";

export { consumeAlfredNotifications } from "../../middlewares/rate-limit";

// Novità per Alfred a voce (sola lettura): run dei Responsabili richieste tramite Alfred finite e nuove voci in
// «Da confermare». Il browser le chiede a intervalli con il cursore della risposta precedente.

export const NOTIFICATIONS_MAX = 10;
export const NOTIFICATIONS_WINDOW_MS = 3_600_000;
export const NOTIFICATION_TEXT_MAX = 300;
export const NOTIFICATION_ITEMS_MAX = 5;

export const NOTIFICATION_MESSAGES = { badCursor: "cursore non valido" } as const;

export type AlfredNotification =
  | {
      kind: "lead_run";
      at: string;
      run: number;
      app: string | null;
      status: string;
      output: string | null;
      error: string | null;
      items: { numero: number; tipo: string; sintesi: string }[];
    }
  | { kind: "queue_item"; at: string; numero: number; tipo: string; squadra: string | null; sintesi: string };

const cut = (text: string | null): string | null => (text === null ? null : text.slice(0, NOTIFICATION_TEXT_MAX));

/** Run del Responsabile richieste tramite Alfred da questo utente (proprietario = chi possiede l'account AI del modello). */
function leadRunsOf(userId: number) {
  return db
    .select({ id: runsTable.id })
    .from(runsTable)
    .innerJoin(agentsTable, eq(agentsTable.id, runsTable.agentId))
    .innerJoin(aiModelsTable, eq(aiModelsTable.id, runsTable.aiModelId))
    .innerJoin(aiAccountsTable, eq(aiAccountsTable.id, aiModelsTable.accountId))
    .where(and(eq(aiAccountsTable.userId, userId), eq(agentsTable.role, "general"), like(runsTable.input, `%${LEAD_INPUT_MARKER}%`)));
}

/**
 * Eventi con tempo in (cursore, now], al più nell'ultima ora e al più 10 per chiamata, in ordine di tempo. Senza
 * cursore risponde solo con quello iniziale (`now`). Un cursore nel futuro rispetto a `now` → AlfredError 400.
 * I tempi si confrontano al millisecondo (il cursore è una data ISO): una voce non si ripete né si perde.
 */
export async function alfredNotifications(userId: number, after: Date | null, now: Date): Promise<{ cursor: string; events: AlfredNotification[] }> {
  if (after === null) return { cursor: now.toISOString(), events: [] };
  if (after.getTime() > now.getTime()) throw new AlfredError(NOTIFICATION_MESSAGES.badCursor, 400);
  const from = new Date(Math.max(after.getTime(), now.getTime() - NOTIFICATIONS_WINDOW_MS));
  // Intervallo (from, now] al millisecondo: colonne con microsecondi tra from+1ms (incluso) e now+1ms (escluso)
  const lower = new Date(from.getTime() + 1);
  const upper = new Date(now.getTime() + 1);

  const leadRuns = leadRunsOf(userId).as("lead_runs");
  const finished = await db
    .select({
      run: runsTable,
      app: appsTable.name,
    })
    .from(runsTable)
    .innerJoin(agentsTable, eq(agentsTable.id, runsTable.agentId))
    .innerJoin(appsTable, eq(appsTable.id, agentsTable.appId))
    .innerJoin(leadRuns, eq(leadRuns.id, runsTable.id))
    .where(and(isNotNull(runsTable.finishedAt), inArray(runsTable.status, ["succeeded", "failed", "cancelled"]), gte(runsTable.finishedAt, lower), lt(runsTable.finishedAt, upper)))
    .orderBy(asc(runsTable.finishedAt), asc(runsTable.id))
    .limit(NOTIFICATIONS_MAX);

  const events: AlfredNotification[] = [];
  for (const { run, app } of finished) {
    const items = await db
      .select({ numero: pendingActionsTable.number, tipo: pendingActionsTable.kind, sintesi: pendingActionsTable.summary })
      .from(pendingActionsTable)
      .where(and(eq(pendingActionsTable.runId, run.id), eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.status, "pending")))
      .orderBy(asc(pendingActionsTable.number))
      .limit(NOTIFICATION_ITEMS_MAX);
    events.push({
      kind: "lead_run",
      at: run.finishedAt!.toISOString(),
      run: run.id,
      app,
      status: run.status,
      output: cut(run.output),
      error: cut(run.errorMessage),
      items: items.map((i) => ({ numero: i.numero, tipo: i.tipo, sintesi: cut(i.sintesi)! })),
    });
  }

  // Le voci nate da una run del Responsabile si annunciano dentro l'evento della run, non da sole
  const fromLeadRun = sql`EXISTS (
    SELECT 1 FROM runs r
    JOIN agents a ON a.id = r.agent_id
    JOIN ai_models m ON m.id = r.ai_model_id
    JOIN ai_accounts c ON c.id = m.account_id
    WHERE r.id = ${pendingActionsTable.runId} AND c.user_id = ${userId} AND a.role = 'general' AND r.input LIKE ${`%${LEAD_INPUT_MARKER}%`}
  )`;
  const queued = await db
    .select({
      numero: pendingActionsTable.number,
      tipo: pendingActionsTable.kind,
      sintesi: pendingActionsTable.summary,
      createdAt: pendingActionsTable.createdAt,
      squadra: teamInstancesTable.name,
    })
    .from(pendingActionsTable)
    .leftJoin(teamInstancesTable, eq(teamInstancesTable.id, pendingActionsTable.teamInstanceId))
    .where(
      and(
        eq(pendingActionsTable.userId, userId),
        eq(pendingActionsTable.status, "pending"),
        gte(pendingActionsTable.createdAt, lower),
        lt(pendingActionsTable.createdAt, upper),
        sql`NOT ${fromLeadRun}`,
      ),
    )
    .orderBy(asc(pendingActionsTable.createdAt), asc(pendingActionsTable.number))
    .limit(NOTIFICATIONS_MAX);
  for (const q of queued) {
    events.push({ kind: "queue_item", at: q.createdAt.toISOString(), numero: q.numero, tipo: q.tipo, squadra: q.squadra ?? null, sintesi: cut(q.sintesi)! });
  }

  events.sort((a, b) => a.at.localeCompare(b.at));
  const page = events.slice(0, NOTIFICATIONS_MAX);
  return { cursor: page.length > 0 ? page[page.length - 1]!.at : now.toISOString(), events: page };
}

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, pendingActionsTable, teamInstancesTable, teamTasksTable, type TeamTaskRow } from "@workspace/db";
import { enqueuePlanItem } from "../actions/queue";
import { logger } from "../logger";
import type { CatalogTool, ToolResult } from "../tools/types";
import { MAX_BULLETIN, MAX_EVENT_DETAIL, emitEvent } from "./events";
import { InstanceError } from "./instances";
import {
  PLAN_MESSAGES,
  PlanSchema,
  diffSummary,
  getApprovedPlan,
  getPlan,
  getPlanForUpdate,
  isRelevantChange,
  nextTaskIds,
  patchPlan,
  writePlanVersion,
  type ManualAction,
  type Plan,
  type PlanTask,
  type PlanView,
} from "./plan";
import { internalTool, type InternalHandler } from "./role-tools";
import { TeamRuleError } from "./rules";
import type { Executor } from "./skills";
import { TASK_MESSAGES, errName, startTask } from "./task-runner";

// Strumenti del capo (spec §4) sopra il PLAN, la coda delle conferme, i compiti e gli eventi. Gli errori tornano al
// modello come risultato dello strumento (ok: false) con messaggi fissi in italiano, mai come eccezioni.

export const LEAD_MESSAGES = {
  invalidArgs: (detail: string) => `argomenti non validi: ${detail}`,
  superseded: "superata da una nuova proposta",
  planChanged: "il piano è cambiato nel frattempo: rileggilo con leggi_piano e riprova",
  taskNotFound: (id: string) => `compito ${id} non trovato nel piano`,
  taskBusy: (id: string) => `il compito ${id} è in corso: aspetta il suo esito`,
  noExecution: (id: string) => `il compito ${id} non è ancora stato eseguito`,
  tooManyManualActions: "troppe azioni manuali nel piano (max 30)",
  notQueued: (message: string) => `piano non proposto, impossibile accodarlo all'utente: ${message}`,
  unknownTaskId: "id di compito sconosciuto: ometti l'id per i compiti nuovi",
  teamNotActive: TASK_MESSAGES.teamNotActive,
  withdrawn: "Il capo ha ritirato la proposta di piano",
  unknownTool: "strumento non disponibile",
} as const;

const MAX_SUMMARY = 500;
const MAX_RESULT_DETAIL = 12_000;

/** Contesto di un turno del capo. */
export interface LeadContext {
  instanceId: number;
  /** Utente che ha attivato la squadra: riceve le voci in coda */
  userId: number;
  teamName: string;
  roleKeys: string[];
}

/** Errore da restituire al modello come risultato dello strumento. */
class LeadToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadToolError";
  }
}

const fail = (content: string): ToolResult => ({ ok: false, content });
const done = (content: string): ToolResult => ({ ok: true, content });

function zodDetail(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "argomenti"}: ${i.message}`)
    .join("; ");
}

/** PLAN in forma compatta per il modello (senza timestamp). */
export function planForModel(plan: PlanView): string {
  return JSON.stringify({
    version: plan.version,
    status: plan.status,
    approvedVersion: plan.approvedVersion,
    objective: plan.objective,
    constraints: plan.constraints,
    openPoints: plan.openPoints,
    tasks: plan.tasks.map((t) => ({ id: t.id, title: t.title, roleKey: t.roleKey, instructions: t.instructions, status: t.status, outcome: t.outcome })),
    manualActions: plan.manualActions.map((a) => ({ id: a.id, text: a.text, done: a.done })),
  });
}

// ─── Definizioni ────────────────────────────────────────────────────────────

const STRING_LIST = (description: string) => ({ type: "array", maxItems: 30, items: { type: "string", maxLength: 500 }, description });

const LEAD_TOOL_DEFS = [
  internalTool("leggi_piano", "Legge il PLAN corrente della squadra (JSON).", { type: "object", properties: {} }),
  internalTool(
    "proponi_piano",
    "Propone il PLAN completo (obiettivo, vincoli, punti aperti, compiti). Senza un piano approvato diventa una voce da approvare; dopo, una modifica di obiettivo, vincoli o compiti va riapprovata, mentre i soli punti aperti si aggiornano subito. I compiti esistenti si indicano con il loro id; i nuovi senza id.",
    {
      type: "object",
      properties: {
        objective: { type: "string", maxLength: 2000 },
        constraints: STRING_LIST("Vincoli del lavoro"),
        openPoints: STRING_LIST("Punti aperti"),
        tasks: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Id di un compito esistente (es. t1); omesso per un compito nuovo" },
              title: { type: "string", maxLength: 200 },
              roleKey: { type: "string", description: "Chiave del ruolo che esegue il compito" },
              instructions: { type: "string", maxLength: 4000 },
            },
            required: ["title", "roleKey", "instructions"],
          },
        },
      },
      required: ["objective", "tasks"],
    },
  ),
  internalTool(
    "aggiorna_piano",
    "Aggiorna senza approvazione punti aperti, azioni manuali (elenco completo) e stato/esito dei compiti non in corso.",
    {
      type: "object",
      properties: {
        openPoints: STRING_LIST("Elenco completo dei punti aperti"),
        manualActions: {
          type: "array",
          maxItems: 30,
          description: "Elenco completo delle azioni manuali per l'utente",
          items: {
            type: "object",
            properties: { id: { type: "string" }, text: { type: "string", maxLength: 500 }, done: { type: "boolean" } },
            required: ["text"],
          },
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string", enum: ["planned", "done", "blocked", "failed"] },
              outcome: { type: ["string", "null"], maxLength: 300 },
            },
            required: ["id"],
          },
        },
      },
    },
  ),
  internalTool("assegna_compito", "Assegna al suo ruolo un compito del PLAN approvato (stato planned, blocked o failed).", {
    type: "object",
    properties: { taskId: { type: "string", description: "Id del compito nel PLAN (es. t1)" } },
    required: ["taskId"],
  }),
  internalTool("leggi_esito", "Legge l'esito dell'ultima esecuzione di un compito del PLAN.", {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
  }),
  internalTool("segnala", "Segnala un evento all'utente nel bollettino; azione_manuale_richiesta aggiunge anche l'azione al PLAN.", {
    type: "object",
    properties: {
      type: { type: "string", enum: ["bloccato", "decisione_richiesta", "azione_manuale_richiesta"] },
      bulletin: { type: "string", maxLength: MAX_BULLETIN, description: "Al massimo due frasi" },
      detail: { type: "string", maxLength: MAX_EVENT_DETAIL },
    },
    required: ["type", "bulletin"],
  }),
  internalTool("chiudi_lavoro", "Dichiara finito il lavoro della squadra (evento lavoro_finito).", {
    type: "object",
    properties: { bulletin: { type: "string", maxLength: MAX_BULLETIN } },
    required: ["bulletin"],
  }),
];

/** Strumenti interni del capo, nell'ordine in cui si offrono al modello. */
export const LEAD_TOOLS: CatalogTool[] = LEAD_TOOL_DEFS;

// ─── Schemi degli argomenti ─────────────────────────────────────────────────

const ProposeSchema = z.object({
  objective: PlanSchema.shape.objective,
  constraints: PlanSchema.shape.constraints.default([]),
  openPoints: PlanSchema.shape.openPoints.default([]),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).max(40).optional(),
        title: z.string().trim().min(1).max(200),
        roleKey: z.string().min(1).max(40),
        instructions: z.string().max(4000),
      }),
    )
    .max(50),
});

const UpdateSchema = z.object({
  openPoints: PlanSchema.shape.openPoints.optional(),
  manualActions: z
    .array(z.object({ id: z.string().min(1).max(40).optional(), text: z.string().trim().min(1).max(500), done: z.boolean().optional() }))
    .max(30)
    .optional(),
  tasks: z
    .array(z.object({ id: z.string().min(1), status: z.enum(["planned", "done", "blocked", "failed"]).optional(), outcome: z.string().max(300).nullable().optional() }))
    .max(50)
    .optional(),
});

const TaskIdSchema = z.object({ taskId: z.string().min(1).max(40) });

const SignalSchema = z.object({
  type: z.enum(["bloccato", "decisione_richiesta", "azione_manuale_richiesta"]),
  bulletin: z.string().trim().min(1).max(MAX_BULLETIN),
  detail: z.string().max(MAX_EVENT_DETAIL).optional(),
});

const CloseWorkSchema = z.object({ bulletin: z.string().trim().min(1).max(MAX_BULLETIN) });

/** Identificatori liberi per le azioni manuali: `m<max+1>`, … */
function nextActionIds(actions: ManualAction[], n: number): string[] {
  const max = actions.reduce((m, a) => {
    const match = /^m(\d+)$/.exec(a.id);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return Array.from({ length: n }, (_, i) => `m${max + 1 + i}`);
}

/**
 * Blocca la riga della squadra (FOR SHARE) dentro `tx` e verifica che sia ancora `active`. Ordine dei lock in tutte
 * le scritture delle squadre: riga di `team_instances`, poi riga del PLAN, poi righe di `pending_actions` (come
 * startTask e closeInstance per la squadra, correctPlan e decidePlanItem per PLAN → coda).
 */
async function lockActiveInstance(tx: Executor, instanceId: number): Promise<void> {
  const [row] = await tx
    .select({ status: teamInstancesTable.status })
    .from(teamInstancesTable)
    .where(eq(teamInstancesTable.id, instanceId))
    .for("share")
    .limit(1);
  if (row?.status !== "active") throw new LeadToolError(LEAD_MESSAGES.teamNotActive);
}

const BUSY = new Set<PlanTask["status"]>(["running", "waiting_node"]);

// ─── Strumenti ──────────────────────────────────────────────────────────────

async function readPlan(ctx: LeadContext): Promise<ToolResult> {
  return done(planForModel(await getPlan(ctx.instanceId)));
}

/** Esito di una transazione di `proponi_piano`. */
type ProposeOutcome =
  | { kind: "changed" }
  | { kind: "patched" }
  | { kind: "approved"; version: number; withdrawn: number }
  | { kind: "proposed"; version: number; number: number }
  | { kind: "notQueued"; version: number; message: string };

/** Annulla la transazione di `proponi_piano` quando la voce non si può accodare (nulla resta scritto). */
class NotQueuedError extends Error {
  constructor(
    readonly version: number,
    message: string,
  ) {
    super(message);
    this.name = "NotQueuedError";
  }
}

const EXECUTION_TO_PLAN: Record<TeamTaskRow["status"], PlanTask["status"]> = {
  queued: "running",
  running: "running",
  waiting_node: "waiting_node",
  done: "done",
  blocked: "blocked",
  failed: "failed",
  cancelled: "failed",
};

/** Stato ed esito dell'ultima esecuzione di ogni compito del PLAN (lettura dal pool, fuori dalle transazioni). */
async function lastExecutions(instanceId: number): Promise<Map<string, { status: PlanTask["status"]; outcome: string | null }>> {
  const rows = await db
    .select({ planTaskId: teamTasksTable.planTaskId, status: teamTasksTable.status, outcome: teamTasksTable.outcome })
    .from(teamTasksTable)
    .where(eq(teamTasksTable.instanceId, instanceId))
    .orderBy(desc(teamTasksTable.id));
  const out = new Map<string, { status: PlanTask["status"]; outcome: string | null }>();
  for (const r of rows) if (!out.has(r.planTaskId)) out.set(r.planTaskId, { status: EXECUTION_TO_PLAN[r.status], outcome: r.outcome?.slice(0, 300) ?? null });
  return out;
}

/**
 * `proponi_piano`: senza versione approvata → versione `proposed` + voce `plan`; con versione approvata e modifica
 * rilevante → versione `proposed` + voce `plan_change` con le differenze; modifica non rilevante → solo i punti
 * aperti sul posto (o, se la riga corrente non è la versione approvata, versione nuova già approvata: una proposta
 * aperta è ritirata). Tutto in una transazione con l'ordine dei lock instance → PLAN → pending_actions: squadra
 * ancora `active`, PLAN invariato dalla lettura, voci di piano aperte rifiutate («superata da una nuova proposta»),
 * versione nuova e voce in coda insieme (una chiusura concorrente si serializza: o prima o dopo, mai a metà).
 */
async function proposePlan(ctx: LeadContext, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = ProposeSchema.safeParse(args);
  if (!parsed.success) return fail(LEAD_MESSAGES.invalidArgs(zodDetail(parsed.error)));
  const input = parsed.data;
  const keys = new Set(ctx.roleKeys);
  const seen = new Set<string>();
  for (const task of input.tasks) {
    if (!keys.has(task.roleKey)) return fail(PLAN_MESSAGES.roleMissing(task.roleKey));
    if (task.id !== undefined) {
      if (seen.has(task.id)) return fail(PLAN_MESSAGES.duplicateTask(task.id));
      seen.add(task.id);
    }
  }

  // Letture dal pool fuori dalla transazione; sotto lock si verifica che il PLAN non sia cambiato nel frattempo
  const current = await getPlan(ctx.instanceId);
  const approved = await getApprovedPlan(ctx.instanceId, current);
  const executions = await lastExecutions(ctx.instanceId);
  const knownIds = new Set([...current.tasks.map((t) => t.id), ...(approved?.tasks ?? []).map((t) => t.id)]);
  if (input.tasks.some((t) => t.id !== undefined && !knownIds.has(t.id))) return fail(LEAD_MESSAGES.unknownTaskId);
  // Id nuovi oltre a quelli del PLAN e delle esecuzioni passate: un compito nuovo non eredita l'esito di uno vecchio
  const usedIds = [...knownIds, ...executions.keys()].map((id) => ({ id }) as PlanTask);
  const fresh = nextTaskIds({ ...current, tasks: usedIds }, input.tasks.filter((t) => t.id === undefined).length);
  const tasks: PlanTask[] = input.tasks.map((t) => ({
    id: t.id ?? fresh.shift()!,
    title: t.title,
    roleKey: t.roleKey,
    instructions: t.instructions,
    status: "planned",
    outcome: null,
  }));
  const draft: Plan = { objective: input.objective, constraints: input.constraints, openPoints: input.openPoints, tasks, manualActions: current.manualActions };
  const relevant = approved === null || isRelevantChange(approved, draft);
  const kind = approved === null ? "plan" : "plan_change";
  const changes = diffSummary(approved, draft);
  const approvedTasks = new Map((approved?.tasks ?? []).map((t) => [t.id, t]));

  let outcome: ProposeOutcome;
  try {
    outcome = await db.transaction(async (tx): Promise<ProposeOutcome> => {
      await lockActiveInstance(tx, ctx.instanceId);
      const locked = await getPlanForUpdate(ctx.instanceId, tx);
      if (locked.version !== current.version || locked.status !== current.status || locked.approvedVersion !== current.approvedVersion) {
        return { kind: "changed" };
      }
      if (!relevant && locked.version === locked.approvedVersion) {
        await patchPlan(ctx.instanceId, { openPoints: draft.openPoints }, tx);
        return { kind: "patched" };
      }
      // Stato ed esito dei compiti restano quelli registrati: dalla riga corrente, altrimenti dall'ultima esecuzione o
      // dalla versione approvata (un compito tolto da una proposta e poi rimesso non torna `planned`); i nuovi `planned`
      const prev = new Map(locked.tasks.map((t) => [t.id, t]));
      const merged = draft.tasks.map((t) => {
        const old = prev.get(t.id) ?? executions.get(t.id) ?? approvedTasks.get(t.id);
        return old ? { ...t, status: old.status, outcome: old.outcome } : t;
      });
      const view = await writePlanVersion(ctx.instanceId, { ...draft, tasks: merged, manualActions: locked.manualActions }, relevant ? "proposed" : "approved", tx);
      const decidedAt = new Date();
      const withdrawn = await tx
        .update(pendingActionsTable)
        .set({ status: "rejected", decisionNote: LEAD_MESSAGES.superseded, decidedAt, finishedAt: decidedAt })
        .where(
          and(
            eq(pendingActionsTable.teamInstanceId, ctx.instanceId),
            inArray(pendingActionsTable.kind, ["plan", "plan_change"]),
            eq(pendingActionsTable.status, "pending"),
          ),
        )
        .returning({ id: pendingActionsTable.id });
      if (!relevant) {
        if (withdrawn.length > 0) {
          await emitEvent({ instanceId: ctx.instanceId, type: "piano_proposto", bulletin: LEAD_MESSAGES.withdrawn }, tx);
        }
        return { kind: "approved", version: view.version, withdrawn: withdrawn.length };
      }

      const summary = (kind === "plan" ? `PLAN della squadra ${ctx.teamName}: ${draft.tasks.length} compiti` : `Modifica del PLAN della squadra ${ctx.teamName}: ${changes}`).slice(0, MAX_SUMMARY);
      const queued = await enqueuePlanItem(
        {
          userId: ctx.userId,
          instanceId: ctx.instanceId,
          kind,
          planVersion: view.version,
          recipient: ctx.teamName,
          summary,
          detail: {
            planVersion: view.version,
            objective: draft.objective,
            constraints: draft.constraints,
            tasks: draft.tasks.map((t) => ({ id: t.id, title: t.title, roleKey: t.roleKey })),
            ...(kind === "plan_change" ? { changes } : {}),
          },
        },
        tx,
      );
      if (!queued.ok) throw new NotQueuedError(view.version, queued.message);
      await emitEvent(
        {
          instanceId: ctx.instanceId,
          type: "piano_proposto",
          bulletin:
            kind === "plan"
              ? `Piano proposto (versione ${view.version}): approva o rifiuta la voce n. ${queued.number}.`
              : `Modifica del piano proposta (versione ${view.version}): approva o rifiuta la voce n. ${queued.number}.`,
          detail: kind === "plan" ? draft.objective : changes,
        },
        tx,
      );
      return { kind: "proposed", version: view.version, number: queued.number };
    });
  } catch (err) {
    if (!(err instanceof NotQueuedError)) throw err;
    outcome = { kind: "notQueued", version: err.version, message: err.message };
  }

  switch (outcome.kind) {
    case "changed":
      return fail(LEAD_MESSAGES.planChanged);
    case "patched":
      return done("nessuna modifica rilevante: punti aperti aggiornati senza approvazione");
    case "approved":
      return done(
        outcome.withdrawn > 0
          ? `nessuna modifica rilevante rispetto al piano approvato: proposta aperta ritirata, versione ${outcome.version} approvata`
          : `nessuna modifica rilevante rispetto al piano approvato: versione ${outcome.version} approvata senza nuova richiesta`,
      );
    case "notQueued":
      // Nulla è stato scritto (transazione annullata): l'utente lo sa dal bollettino, il capo dal risultato
      logger.warn({ instanceId: ctx.instanceId }, "Piano proposto dal capo non accodato");
      await emitEvent({ instanceId: ctx.instanceId, type: "bloccato", bulletin: `Piano non proposto: ${outcome.message}` });
      return fail(LEAD_MESSAGES.notQueued(outcome.message));
    case "proposed":
      return done(`piano proposto (versione ${outcome.version}): voce n. ${outcome.number} in attesa dell'approvazione dell'utente`);
  }
}

/** `aggiorna_piano`: punti aperti, azioni manuali e stato/esito dei compiti, sulla riga corrente bloccata. */
async function updatePlan(ctx: LeadContext, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = UpdateSchema.safeParse(args);
  if (!parsed.success) return fail(LEAD_MESSAGES.invalidArgs(zodDetail(parsed.error)));
  const input = parsed.data;
  await db.transaction(async (tx) => {
    await lockActiveInstance(tx, ctx.instanceId);
    const locked = await getPlanForUpdate(ctx.instanceId, tx);
    const byId = new Map(locked.tasks.map((t) => [t.id, t]));
    for (const change of input.tasks ?? []) {
      const task = byId.get(change.id);
      if (!task) throw new LeadToolError(LEAD_MESSAGES.taskNotFound(change.id));
      if (BUSY.has(task.status)) throw new LeadToolError(LEAD_MESSAGES.taskBusy(change.id));
    }
    let manualActions: ManualAction[] | undefined;
    if (input.manualActions) {
      const existing = new Map(locked.manualActions.map((a) => [a.id, a]));
      const fresh = nextActionIds(locked.manualActions, input.manualActions.length);
      const now = new Date().toISOString();
      manualActions = input.manualActions.map((a, i) => {
        const old = a.id !== undefined ? existing.get(a.id) : undefined;
        // Un'azione già segnata come fatta (dall'utente) resta fatta
        const isDone = (old?.done ?? false) || (a.done ?? false);
        return { id: old?.id ?? fresh[i]!, text: a.text, done: isDone, doneAt: isDone ? (old?.doneAt ?? now) : null };
      });
    }
    await patchPlan(
      ctx.instanceId,
      {
        ...(input.openPoints ? { openPoints: input.openPoints } : {}),
        ...(manualActions ? { manualActions } : {}),
        ...(input.tasks ? { tasks: input.tasks } : {}),
      },
      tx,
    );
  });
  return done("piano aggiornato");
}

/**
 * `assegna_compito`: solo un compito del PLAN approvato in stato planned, blocked o failed. Lo stato della squadra
 * lo verifica startTask con la riga della squadra bloccata («la squadra non è attiva»).
 */
async function assignTask(ctx: LeadContext, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = TaskIdSchema.safeParse(args);
  if (!parsed.success) return fail(LEAD_MESSAGES.invalidArgs(zodDetail(parsed.error)));
  const { taskId } = parsed.data;
  const current = await getPlan(ctx.instanceId);
  const approved = await getApprovedPlan(ctx.instanceId, current);
  if (!approved?.tasks.some((t) => t.id === taskId)) return fail(TASK_MESSAGES.notInPlan);
  const status = current.tasks.find((t) => t.id === taskId)?.status ?? "planned";
  if (BUSY.has(status)) return fail(TASK_MESSAGES.alreadyActive);
  if (status === "done") return fail(TASK_MESSAGES.notInPlan);
  try {
    const row = await startTask(ctx.instanceId, taskId);
    return done(
      row.status === "waiting_node"
        ? `compito ${taskId} assegnato al ruolo ${row.roleKey}: in attesa del nodo locale`
        : `compito ${taskId} assegnato al ruolo ${row.roleKey}: l'esito arriverà in un turno successivo`,
    );
  } catch (err) {
    if (err instanceof InstanceError || err instanceof TeamRuleError) return fail(err.message);
    throw err;
  }
}

/** `leggi_esito`: ultima esecuzione del compito. */
async function readOutcome(ctx: LeadContext, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = TaskIdSchema.safeParse(args);
  if (!parsed.success) return fail(LEAD_MESSAGES.invalidArgs(zodDetail(parsed.error)));
  const [row] = await db
    .select()
    .from(teamTasksTable)
    .where(and(eq(teamTasksTable.instanceId, ctx.instanceId), eq(teamTasksTable.planTaskId, parsed.data.taskId)))
    .orderBy(desc(teamTasksTable.id))
    .limit(1);
  if (!row) return fail(LEAD_MESSAGES.noExecution(parsed.data.taskId));
  return done(
    JSON.stringify({
      taskId: row.planTaskId,
      roleKey: row.roleKey,
      status: row.status,
      outcome: row.outcome,
      detail: row.detail === null ? null : row.detail.slice(0, MAX_RESULT_DETAIL),
      error: row.error,
    }),
  );
}

/** `segnala`: evento nel bollettino; `azione_manuale_richiesta` aggiunge anche l'azione al PLAN. */
async function signal(ctx: LeadContext, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = SignalSchema.safeParse(args);
  if (!parsed.success) return fail(LEAD_MESSAGES.invalidArgs(zodDetail(parsed.error)));
  const input = parsed.data;
  await db.transaction(async (tx) => {
    await lockActiveInstance(tx, ctx.instanceId);
    if (input.type === "azione_manuale_richiesta") {
      const locked = await getPlanForUpdate(ctx.instanceId, tx);
      if (locked.manualActions.length >= 30) throw new LeadToolError(LEAD_MESSAGES.tooManyManualActions);
      const [id] = nextActionIds(locked.manualActions, 1);
      await patchPlan(ctx.instanceId, { manualActions: [...locked.manualActions, { id: id!, text: input.bulletin, done: false, doneAt: null }] }, tx);
    }
    await emitEvent({ instanceId: ctx.instanceId, type: input.type, bulletin: input.bulletin, ...(input.detail ? { detail: input.detail } : {}) }, tx);
  });
  return done("segnalazione registrata nel bollettino");
}

/** `chiudi_lavoro`: evento `lavoro_finito` (la squadra resta attiva finché l'utente non la chiude). */
async function closeWork(ctx: LeadContext, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = CloseWorkSchema.safeParse(args);
  if (!parsed.success) return fail(LEAD_MESSAGES.invalidArgs(zodDetail(parsed.error)));
  await db.transaction(async (tx) => {
    await lockActiveInstance(tx, ctx.instanceId);
    await emitEvent({ instanceId: ctx.instanceId, type: "lavoro_finito", bulletin: parsed.data.bulletin }, tx);
  });
  return done("lavoro dichiarato finito: l'utente chiuderà la squadra");
}

const HANDLERS: Record<string, (ctx: LeadContext, args: Record<string, unknown>) => Promise<ToolResult>> = {
  leggi_piano: readPlan,
  proponi_piano: proposePlan,
  aggiorna_piano: updatePlan,
  assegna_compito: assignTask,
  leggi_esito: readOutcome,
  segnala: signal,
  chiudi_lavoro: closeWork,
};

/** Esecutore degli strumenti interni del capo: un errore atteso torna al modello, uno inatteso diventa un messaggio fisso. */
export function leadToolHandler(ctx: LeadContext): InternalHandler {
  return async (tool, args) => {
    const handler = HANDLERS[tool.name];
    if (!handler) return fail(LEAD_MESSAGES.unknownTool);
    try {
      return await handler(ctx, args);
    } catch (err) {
      if (err instanceof LeadToolError) return fail(err.message);
      if (err instanceof z.ZodError) return fail(LEAD_MESSAGES.invalidArgs(zodDetail(err)));
      logger.error({ instanceId: ctx.instanceId, tool: tool.name, errName: errName(err) }, "Strumento del capo non riuscito");
      return fail(`errore interno nello strumento ${tool.name}`);
    }
  };
}

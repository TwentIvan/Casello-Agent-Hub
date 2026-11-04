import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  pendingActionsTable,
  teamPlansTable,
  teamPlanVersionsTable,
  type PlanData,
  type TeamPlanRow,
} from "@workspace/db";
import { z } from "zod";
import { InstanceError, getInstance, type InstanceView } from "./instances";
import { TeamRuleError } from "./rules";
import type { Executor } from "./skills";
import { enqueueTurnReason } from "./turn-queue";

// PLAN di una squadra: contenuto versionato (obiettivo, vincoli, compiti, azioni manuali, punti aperti).
// Due modi di scrivere: `writePlanVersion` (versione nuova, per proposte e correzioni) e `patchPlan`
// (aggiorna la riga corrente senza nuova versione: stato/esito dei compiti, azioni manuali, punti aperti).
// Letture dal pool e validazioni sempre fuori dalle transazioni di scrittura.

export const PLAN_MESSAGES = {
  roleMissing: (key: string) => `ruolo ${key} inesistente`,
  actionNotFound: "azione manuale non trovata",
  supersededByUser: "superata dalla modifica dell'utente",
  duplicateTask: (id: string) => `compito ${id} ripetuto`,
} as const;

export const TASK_STATUSES = ["planned", "running", "waiting_node", "done", "blocked", "failed"] as const;

export const PlanTaskSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  roleKey: z.string().min(1).max(40),
  instructions: z.string().max(4000),
  status: z.enum(TASK_STATUSES),
  outcome: z.string().max(300).nullable(),
  // Messo dal server se manca
  updatedAt: z.string().optional(),
});

export const ManualActionSchema = z.object({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(500),
  done: z.boolean(),
  doneAt: z.string().nullable(),
});

export const PlanSchema = z.object({
  objective: z.string().max(2000),
  constraints: z.array(z.string().max(500)).max(30),
  openPoints: z.array(z.string().max(500)).max(30),
  tasks: z.array(PlanTaskSchema).max(50),
  manualActions: z.array(ManualActionSchema).max(30),
});

export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type ManualAction = z.infer<typeof ManualActionSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type PlanStatus = "draft" | "proposed" | "approved";
export type PlanView = Omit<Plan, "tasks"> & {
  tasks: Array<PlanTask & { updatedAt: string }>;
  version: number;
  status: PlanStatus;
  approvedVersion: number | null;
  updatedAt: Date;
};

export type PlanPatch = {
  tasks?: Array<{ id: string; status?: PlanTask["status"]; outcome?: string | null }>;
  manualActions?: ManualAction[];
  openPoints?: string[];
};

function toView(row: TeamPlanRow): PlanView {
  return {
    objective: row.objective,
    constraints: row.constraints,
    openPoints: row.openPoints,
    tasks: row.tasks,
    manualActions: row.manualActions,
    version: row.version,
    status: row.status,
    approvedVersion: row.approvedVersion,
    updatedAt: row.updatedAt,
  };
}

function toData(plan: Plan, now: string): PlanData {
  return {
    objective: plan.objective,
    constraints: plan.constraints,
    openPoints: plan.openPoints,
    tasks: plan.tasks.map((t) => ({ ...t, updatedAt: t.updatedAt ?? now })),
    manualActions: plan.manualActions,
  };
}

/** PLAN corrente della squadra; se manca crea un `draft` vuoto (versione 1). */
export async function getPlan(instanceId: number, executor: Executor = db): Promise<PlanView> {
  const [row] = await executor.select().from(teamPlansTable).where(eq(teamPlansTable.instanceId, instanceId)).limit(1);
  if (row) return toView(row);
  await executor.insert(teamPlansTable).values({ instanceId }).onConflictDoNothing();
  const [created] = await executor.select().from(teamPlansTable).where(eq(teamPlansTable.instanceId, instanceId)).limit(1);
  return toView(created!);
}

/** Riga del PLAN bloccata FOR UPDATE dentro la transazione `tx` (creata se manca). */
async function lockPlanRow(tx: Executor, instanceId: number): Promise<TeamPlanRow> {
  await tx.insert(teamPlansTable).values({ instanceId }).onConflictDoNothing();
  const [row] = await tx.select().from(teamPlansTable).where(eq(teamPlansTable.instanceId, instanceId)).for("update").limit(1);
  return row!;
}

/** PLAN corrente letto con la riga bloccata FOR UPDATE: per confrontare versione e stato e scrivere nella stessa transazione `tx`. */
export async function getPlanForUpdate(instanceId: number, tx: Executor): Promise<PlanView> {
  return toView(await lockPlanRow(tx, instanceId));
}

/**
 * Scrive una versione nuova (+1) del PLAN con la sua riga in `team_plan_versions`. Con stato `approved` la versione
 * nuova è anche quella approvata; con gli altri stati `approved_version` resta com'è.
 */
export async function writePlanVersion(instanceId: number, plan: Plan, status: PlanStatus, executor: Executor = db): Promise<PlanView> {
  const parsed = PlanSchema.parse(plan);
  return executor.transaction(async (tx) => {
    const current = await lockPlanRow(tx, instanceId);
    const version = current.version + 1;
    const now = new Date();
    const data = toData(parsed, now.toISOString());
    const [row] = await tx
      .update(teamPlansTable)
      .set({
        version,
        status,
        objective: data.objective,
        constraints: data.constraints,
        openPoints: data.openPoints,
        tasks: data.tasks,
        manualActions: data.manualActions,
        approvedVersion: status === "approved" ? version : current.approvedVersion,
        updatedAt: now,
      })
      .where(eq(teamPlansTable.id, current.id))
      .returning();
    await tx.insert(teamPlanVersionsTable).values({ instanceId, version, plan: data });
    return toView(row!);
  });
}

/** Cambia solo `status` e `approved_version`, senza versione nuova (approvazione e rifiuto delle proposte). */
export async function setPlanStatus(instanceId: number, status: PlanStatus, approvedVersion?: number | null, executor: Executor = db): Promise<PlanView> {
  return executor.transaction(async (tx) => {
    const current = await lockPlanRow(tx, instanceId);
    const [row] = await tx
      .update(teamPlansTable)
      .set({
        status,
        approvedVersion: approvedVersion === undefined ? current.approvedVersion : approvedVersion,
        updatedAt: new Date(),
      })
      .where(eq(teamPlansTable.id, current.id))
      .returning();
    return toView(row!);
  });
}

/** Aggiorna il PLAN corrente sul posto: nessuna versione nuova, nessun cambio di stato. */
export async function patchPlan(instanceId: number, patch: PlanPatch, executor: Executor = db): Promise<PlanView> {
  const openPoints = patch.openPoints === undefined ? undefined : PlanSchema.shape.openPoints.parse(patch.openPoints);
  const manualActions = patch.manualActions === undefined ? undefined : PlanSchema.shape.manualActions.parse(patch.manualActions);
  return executor.transaction(async (tx) => {
    const current = await lockPlanRow(tx, instanceId);
    const now = new Date();
    const changes = new Map((patch.tasks ?? []).map((t) => [t.id, t]));
    const tasks = current.tasks.map((task) => {
      const change = changes.get(task.id);
      if (!change) return task;
      return {
        ...task,
        status: change.status ?? task.status,
        outcome: change.outcome === undefined ? task.outcome : change.outcome === null ? null : change.outcome.slice(0, 300),
        updatedAt: now.toISOString(),
      };
    });
    const [row] = await tx
      .update(teamPlansTable)
      .set({
        tasks,
        ...(openPoints ? { openPoints } : {}),
        ...(manualActions ? { manualActions } : {}),
        updatedAt: now,
      })
      .where(eq(teamPlansTable.id, current.id))
      .returning();
    return toView(row!);
  });
}

// ─── Funzioni pure ──────────────────────────────────────────────────────────

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const contentOf = (t: PlanTask) => ({ title: t.title, roleKey: t.roleKey, instructions: t.instructions });
// Confronto campo per campo: indipendente dall'ordine delle chiavi (il jsonb di Postgres le riordina)
const sameTaskContent = (a: PlanTask, b: PlanTask) => a.title === b.title && a.roleKey === b.roleKey && a.instructions === b.instructions;

/** Una modifica è rilevante (richiede l'approvazione) se cambia obiettivo, vincoli o compiti (aggiunti, tolti, titolo/ruolo/istruzioni). */
export function isRelevantChange(before: Plan | null, after: Plan): boolean {
  if (!before) return true;
  if (before.objective !== after.objective || !same(before.constraints, after.constraints)) return true;
  const prev = new Map(before.tasks.map((t) => [t.id, t]));
  const next = new Map(after.tasks.map((t) => [t.id, t]));
  if (prev.size !== next.size) return true;
  for (const [id, task] of next) {
    const old = prev.get(id);
    if (!old || !same(contentOf(old), contentOf(task))) return true;
  }
  return false;
}

/** Riassunto in italiano delle differenze rilevanti, per la voce in coda e il motivo del turno. */
export function diffSummary(before: Plan | null, after: Plan): string {
  const parts: string[] = [];
  const prev = new Map((before?.tasks ?? []).map((t) => [t.id, t]));
  const next = new Map(after.tasks.map((t) => [t.id, t]));
  const label = (t: PlanTask) => `${t.id} ${t.title}`;
  const added = after.tasks.filter((t) => !prev.has(t.id));
  const removed = (before?.tasks ?? []).filter((t) => !next.has(t.id));
  const changed = after.tasks.filter((t) => {
    const old = prev.get(t.id);
    return old && !same(contentOf(old), contentOf(t));
  });
  if (added.length > 0) parts.push(`compiti aggiunti: ${added.map(label).join(", ")}`);
  if (removed.length > 0) parts.push(`compiti tolti: ${removed.map(label).join(", ")}`);
  if (changed.length > 0) parts.push(`compiti modificati: ${changed.map(label).join(", ")}`);
  if ((before?.objective ?? "") !== after.objective) parts.push("obiettivo cambiato");
  if (!same(before?.constraints ?? [], after.constraints)) parts.push("vincoli cambiati");
  return parts.length > 0 ? parts.join("; ") : "nessuna modifica rilevante";
}

/** Identificatori liberi per i prossimi `n` compiti: `t<max+1>`, `t<max+2>`… */
export function nextTaskIds(plan: Plan, n: number): string[] {
  const max = plan.tasks.reduce((m, t) => {
    const match = /^t(\d+)$/.exec(t.id);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return Array.from({ length: n }, (_, i) => `t${max + 1 + i}`);
}

// ─── Operazioni dell'utente ─────────────────────────────────────────────────

/** Squadra non chiusa (404 se manca, 409 se chiusa). */
async function openInstance(instanceId: number): Promise<InstanceView> {
  const instance = await getInstance(instanceId);
  if (instance.status === "closed") throw new InstanceError(409, "squadra chiusa");
  return instance;
}

/** Correzione dell'utente: versione nuova già approvata, proposte aperte superate, turno del capo in coda. */
export async function correctPlan(instanceId: number, input: Plan): Promise<PlanView> {
  const plan = PlanSchema.parse(input);
  const instance = await openInstance(instanceId);
  const keys = new Set(instance.roles.map((r) => r.key));
  const seen = new Set<string>();
  for (const task of plan.tasks) {
    if (!keys.has(task.roleKey)) throw new TeamRuleError(PLAN_MESSAGES.roleMissing(task.roleKey));
    if (seen.has(task.id)) throw new TeamRuleError(PLAN_MESSAGES.duplicateTask(task.id));
    seen.add(task.id);
  }
  let before!: Plan;
  const view = await db.transaction(async (tx) => {
    // Stato ed esito dei compiti esistenti li scrivono il capo e i ruoli (patchPlan): si leggono sotto lock e non si
    // sovrascrivono con i valori del client; i compiti nuovi partono `planned`. Chi non cambia contenuto conserva updatedAt.
    const current = await lockPlanRow(tx, instanceId);
    before = toView(current);
    const prev = new Map(current.tasks.map((t) => [t.id, t]));
    const now = new Date().toISOString();
    const merged = plan.tasks.map((t) => {
      const old = prev.get(t.id);
      if (!old) return { ...t, status: "planned" as const, outcome: null, updatedAt: now };
      return { ...t, status: old.status, outcome: old.outcome, updatedAt: sameTaskContent(old, t) ? old.updatedAt : now };
    });
    const written = await writePlanVersion(instanceId, { ...plan, tasks: merged }, "approved", tx);
    const decidedAt = new Date();
    await tx
      .update(pendingActionsTable)
      .set({ status: "rejected", decisionNote: PLAN_MESSAGES.supersededByUser, decidedAt, finishedAt: decidedAt })
      .where(
        and(
          eq(pendingActionsTable.teamInstanceId, instanceId),
          inArray(pendingActionsTable.kind, ["plan", "plan_change"]),
          eq(pendingActionsTable.status, "pending"),
        ),
      );
    return written;
  });
  await enqueueTurnReason(instanceId, { type: "request", text: `Il piano è stato modificato dall'utente: ${diffSummary(before, plan)}` });
  return view;
}

/** Segna «Fatto» un'azione manuale (aggiorna il PLAN corrente senza versione nuova). */
export async function markManualActionDone(instanceId: number, actionId: string): Promise<PlanView> {
  await openInstance(instanceId);
  // Lettura e scrittura sulla stessa riga bloccata: un patchPlan concorrente non viene sovrascritto
  return db.transaction(async (tx) => {
    const current = await lockPlanRow(tx, instanceId);
    const action = current.manualActions.find((a) => a.id === actionId);
    if (!action) throw new InstanceError(404, PLAN_MESSAGES.actionNotFound);
    if (action.done) return toView(current);
    const now = new Date().toISOString();
    return patchPlan(instanceId, { manualActions: current.manualActions.map((a) => (a.id === actionId ? { ...a, done: true, doneAt: now } : a)) }, tx);
  });
}

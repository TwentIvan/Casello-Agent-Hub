// Politica della flotta degli agenti (issue #117): regole di coordinamento comuni a tutte le run, in una sola riga
// di `fleet_policy`. Pausa centrale (lo scheduler non avvia run nuove e gli inneschi non scattano; le run in corso
// arrivano in fondo) e limiti di concorrenza dello scheduler. Senza riga valgono i valori predefiniti.
import { eq, sql } from "drizzle-orm";
import { db, fleetPolicyTable, usersTable } from "@workspace/db";
import { looksLikeCredential } from "../memory/credentials";

export const FLEET_DEFAULTS = { maxRunningRuns: 6, maxRunningPerAgent: 2 } as const;
export const FLEET_LIMITS = {
  maxRunningRuns: { min: 1, max: 20 },
  maxRunningPerAgent: { min: 1, max: 10 },
  pauseReason: 300,
} as const;

export const FLEET_MESSAGES = {
  invalidLimits: "limiti della flotta non validi: run in corso 1..20 in tutto e 1..10 per agente, per agente non oltre il totale",
  invalidReason: "motivo della pausa non valido: al più 300 caratteri su una riga, senza credenziali",
  alreadyPaused: "la flotta è già in pausa",
  notPaused: "la flotta non è in pausa",
} as const;

export interface FleetPolicy {
  paused: boolean;
  pausedAt: Date | null;
  pausedBy: number | null;
  pausedByName: string | null;
  pauseReason: string | null;
  maxRunningRuns: number;
  maxRunningPerAgent: number;
  updatedAt: Date | null;
}

const DEFAULT_POLICY: FleetPolicy = {
  paused: false,
  pausedAt: null,
  pausedBy: null,
  pausedByName: null,
  pauseReason: null,
  ...FLEET_DEFAULTS,
  updatedAt: null,
};

/** Politica attuale (riga unica o valori predefiniti), con il nome di chi ha messo in pausa. */
export async function readFleetPolicy(): Promise<FleetPolicy> {
  const [row] = await db
    .select({ policy: fleetPolicyTable, pausedByName: usersTable.name, pausedByEmail: usersTable.email })
    .from(fleetPolicyTable)
    .leftJoin(usersTable, eq(usersTable.id, fleetPolicyTable.pausedBy))
    .where(eq(fleetPolicyTable.id, 1));
  if (!row) return { ...DEFAULT_POLICY };
  const p = row.policy;
  return {
    paused: p.paused,
    pausedAt: p.pausedAt,
    pausedBy: p.pausedBy,
    pausedByName: p.pausedBy === null ? null : (row.pausedByName ?? row.pausedByEmail ?? null),
    pauseReason: p.pauseReason,
    maxRunningRuns: p.maxRunningRuns,
    maxRunningPerAgent: p.maxRunningPerAgent,
    updatedAt: p.updatedAt,
  };
}

/** Limiti dello scheduler e pausa, letti a ogni giro: una sola query sulla chiave primaria. */
export async function readSchedulerPolicy(): Promise<{ paused: boolean; maxRunningRuns: number; maxRunningPerAgent: number }> {
  const [row] = await db
    .select({
      paused: fleetPolicyTable.paused,
      maxRunningRuns: fleetPolicyTable.maxRunningRuns,
      maxRunningPerAgent: fleetPolicyTable.maxRunningPerAgent,
    })
    .from(fleetPolicyTable)
    .where(eq(fleetPolicyTable.id, 1));
  return row ?? { paused: false, ...FLEET_DEFAULTS };
}

/** Vero se la flotta è in pausa (gli inneschi non scattano). */
export async function fleetPaused(): Promise<boolean> {
  return (await readSchedulerPolicy()).paused;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Controllo dei limiti: interi negli intervalli e il limite per agente non oltre il totale. */
export function checkLimits(maxRunningRuns: unknown, maxRunningPerAgent: unknown): { ok: true } | { ok: false; error: string } {
  const { maxRunningRuns: total, maxRunningPerAgent: perAgent } = FLEET_LIMITS;
  if (
    !isInt(maxRunningRuns) ||
    !isInt(maxRunningPerAgent) ||
    maxRunningRuns < total.min ||
    maxRunningRuns > total.max ||
    maxRunningPerAgent < perAgent.min ||
    maxRunningPerAgent > perAgent.max ||
    maxRunningPerAgent > maxRunningRuns
  ) {
    return { ok: false, error: FLEET_MESSAGES.invalidLimits };
  }
  return { ok: true };
}

/** Motivo della pausa normalizzato (vuoto → null) o errore: una riga, ≤ 300 caratteri, nessuna credenziale. */
export function cleanPauseReason(reason: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (reason === undefined || reason === null) return { ok: true, value: null };
  if (typeof reason !== "string") return { ok: false, error: FLEET_MESSAGES.invalidReason };
  const value = reason.trim();
  if (value === "") return { ok: true, value: null };
  // eslint-disable-next-line no-control-regex
  if (value.length > FLEET_LIMITS.pauseReason || /[\u0000-\u001f\u007f]/.test(value) || looksLikeCredential(value)) {
    return { ok: false, error: FLEET_MESSAGES.invalidReason };
  }
  return { ok: true, value };
}

async function upsert(values: Partial<typeof fleetPolicyTable.$inferInsert>): Promise<void> {
  await db
    .insert(fleetPolicyTable)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: fleetPolicyTable.id, set: { ...values, updatedAt: sql`now()` } });
}

/** Salva i limiti di concorrenza (già controllati con checkLimits). */
export async function saveFleetLimits(userId: number, limits: { maxRunningRuns: number; maxRunningPerAgent: number }): Promise<void> {
  await upsert({ ...limits, updatedBy: userId });
}

/**
 * Mette in pausa la flotta. UPDATE condizionato a `paused = false` (o riga nuova): due pause concorrenti, una sola
 * riesce. Falso se era già in pausa.
 */
export async function pauseFleet(userId: number, reason: string | null): Promise<boolean> {
  const rows = await db.execute<{ id: number }>(sql`
    insert into fleet_policy (id, paused, paused_at, paused_by, pause_reason, updated_by, updated_at)
    values (1, true, now(), ${userId}, ${reason}, ${userId}, now())
    on conflict (id) do update
       set paused = true, paused_at = now(), paused_by = excluded.paused_by, pause_reason = excluded.pause_reason,
           updated_by = excluded.updated_by, updated_at = now()
     where fleet_policy.paused = false
    returning id`);
  return rows.rows.length > 0;
}

/** Toglie la pausa. Falso se la flotta non era in pausa. */
export async function resumeFleet(userId: number): Promise<boolean> {
  const rows = await db
    .update(fleetPolicyTable)
    .set({ paused: false, pausedAt: null, pausedBy: null, pauseReason: null, updatedBy: userId, updatedAt: sql`now()` })
    .where(sql`${fleetPolicyTable.id} = 1 and ${fleetPolicyTable.paused} = true`)
    .returning({ id: fleetPolicyTable.id });
  return rows.length > 0;
}

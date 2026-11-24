// Salute degli agenti della flotta (issue #117): regola pura dai numeri delle ultime 24 ore. Nessun accesso al DB.

export type FleetHealth = "healthy" | "degraded" | "failing" | "off";

/** Problemi riconosciuti, in ordine di gravità: codici stabili, il testo lo sceglie la console. */
export type FleetIssue = "no_model" | "trigger_error" | "high_failure" | "some_failures" | "backlog" | "stuck_run";

export interface FleetHealthInput {
  /** Stato dell'agente: solo `active` lavora */
  status: string;
  hasModel: boolean;
  /** Run concluse nella finestra (cancelled escluse dal tasso di successo) */
  succeeded: number;
  failed: number;
  /** Inneschi fermi in errore */
  triggersInError: number;
  /** Run in coda (`pending`) */
  pendingRuns: number;
  /** Run `running` partite da oltre FLEET_STUCK_MS */
  stuckRuns: number;
}

/** Sotto questo tasso di successo (con abbastanza run) l'agente fallisce. */
export const FLEET_FAILING_RATE = 0.5;
/** Run concluse minime per giudicare dal tasso. */
export const FLEET_MIN_RUNS = 3;
/** Coda oltre la quale l'agente è rallentato. */
export const FLEET_BACKLOG = 20;
/** Una run in corso da più di 15 minuti è sospetta (il turno di una run dura al più pochi minuti). */
export const FLEET_STUCK_MS = 15 * 60_000;
/** Finestra delle statistiche. */
export const FLEET_WINDOW_MS = 24 * 3_600_000;

const FAILING: ReadonlySet<FleetIssue> = new Set(["no_model", "trigger_error", "high_failure"]);

/** Tasso di successo delle run concluse (null senza run concluse). */
export function successRate(succeeded: number, failed: number): number | null {
  const total = succeeded + failed;
  return total === 0 ? null : succeeded / total;
}

/**
 * Problemi e salute: `off` per un agente non attivo; `failing` senza modello, con un innesco in errore o con meno della
 * metà delle run riuscite (almeno 3 concluse); `degraded` con qualche errore, una coda lunga o una run bloccata;
 * altrimenti `healthy` (anche senza run).
 */
export function fleetHealth(input: FleetHealthInput): { health: FleetHealth; issues: FleetIssue[] } {
  if (input.status !== "active") return { health: "off", issues: [] };
  const issues: FleetIssue[] = [];
  if (!input.hasModel) issues.push("no_model");
  if (input.triggersInError > 0) issues.push("trigger_error");
  const rate = successRate(input.succeeded, input.failed);
  if (rate !== null && input.succeeded + input.failed >= FLEET_MIN_RUNS && rate < FLEET_FAILING_RATE) issues.push("high_failure");
  else if (input.failed > 0) issues.push("some_failures");
  if (input.stuckRuns > 0) issues.push("stuck_run");
  if (input.pendingRuns >= FLEET_BACKLOG) issues.push("backlog");
  const health: FleetHealth = issues.some((i) => FAILING.has(i)) ? "failing" : issues.length > 0 ? "degraded" : "healthy";
  return { health, issues };
}

// Flotta degli agenti (issue #117): testi, LED e regole della pagina «Flotta». Funzioni pure.
import type { FleetAgent, FleetHealth, FleetIssue } from "@workspace/api-client-react";
import type { LedState } from "@/components/brand/led";

export const FLEET_HEALTH_LABELS: Record<FleetHealth, string> = {
  failing: "Fallisce",
  degraded: "Rallentato",
  healthy: "Sano",
  off: "Spento",
};

export const FLEET_HEALTH_LED: Record<FleetHealth, LedState> = {
  failing: "ko",
  degraded: "ask",
  healthy: "ok",
  off: "idle",
};

export const FLEET_ISSUE_LABELS: Record<FleetIssue, string> = {
  no_model: "senza modello",
  trigger_error: "innesco in errore",
  high_failure: "meno della metà delle run riuscite",
  some_failures: "qualche run fallita",
  backlog: "coda lunga",
  stuck_run: "run in corso da oltre 15 minuti",
};

export const FLEET_LIMITS = { maxRunningRuns: { min: 1, max: 20 }, maxRunningPerAgent: { min: 1, max: 10 }, pauseReason: 300 } as const;

/** Testo dei problemi su una riga, nell'ordine del server. */
export function fleetIssuesText(issues: readonly FleetIssue[]): string | null {
  return issues.length === 0 ? null : issues.map((i) => FLEET_ISSUE_LABELS[i] ?? i).join(" · ");
}

/** Tasso di successo in percentuale intera: "67 %", oppure "—" senza run concluse. */
export function formatSuccessRate(rate: number | null | undefined): string {
  return rate == null ? "—" : `${Math.round(rate * 100)} %`;
}

/** Run concluse nelle 24 ore: "5 riuscite · 1 fallita". */
export function finishedRunsText(a: Pick<FleetAgent, "succeeded24h" | "failed24h">): string {
  if (a.succeeded24h === 0 && a.failed24h === 0) return "nessuna";
  const parts = [`${a.succeeded24h} ${a.succeeded24h === 1 ? "riuscita" : "riuscite"}`];
  if (a.failed24h > 0) parts.push(`${a.failed24h} ${a.failed24h === 1 ? "fallita" : "fallite"}`);
  return parts.join(" · ");
}

/** Controllo dei limiti nel modulo (stessa regola del server); null se validi. */
export function fleetLimitsError(maxRunningRuns: number, maxRunningPerAgent: number): string | null {
  const t = FLEET_LIMITS.maxRunningRuns;
  const a = FLEET_LIMITS.maxRunningPerAgent;
  if (!Number.isInteger(maxRunningRuns) || maxRunningRuns < t.min || maxRunningRuns > t.max) return `Run in corso in tutto: da ${t.min} a ${t.max}`;
  if (!Number.isInteger(maxRunningPerAgent) || maxRunningPerAgent < a.min || maxRunningPerAgent > a.max) return `Run in corso per agente: da ${a.min} a ${a.max}`;
  if (maxRunningPerAgent > maxRunningRuns) return "Il limite per agente non può superare quello totale";
  return null;
}

export type FleetFilter = "all" | "attention" | FleetHealth;

/** Filtro della tabella: «Da guardare» = fallisce o rallentato. */
export function filterFleet(agents: readonly FleetAgent[], filter: FleetFilter, appId: number | null): FleetAgent[] {
  return agents.filter(
    (a) =>
      (appId === null || a.appId === appId) &&
      (filter === "all" || (filter === "attention" ? a.health === "failing" || a.health === "degraded" : a.health === filter)),
  );
}

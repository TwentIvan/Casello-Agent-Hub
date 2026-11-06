import type { TeamPlanStatus, TeamPlanTaskStatus, TeamTaskStatus, TeamTurnStatus } from "@workspace/api-client-react";
import { Led, type LedState } from "@/components/brand/led";

// Stati del lavoro di una squadra: PLAN, compiti del PLAN, esecuzioni dei compiti e turni del capo.

function StatusBadge({ label, style, className }: { label: string; style: LedState; className?: string }) {
  return <Led state={style} label={label} className={className} />;
}

const PLAN: Record<TeamPlanStatus, [string, LedState]> = {
  draft: ["Bozza", "idle"],
  proposed: ["Proposto", "ask"],
  approved: ["Approvato", "ok"],
};

export function PlanStatusBadge({ status }: { status: TeamPlanStatus }) {
  const [label, style] = PLAN[status];
  return <StatusBadge label={label} style={style} />;
}

const WORK: Record<TeamPlanTaskStatus | TeamTaskStatus, [string, LedState]> = {
  planned: ["Pianificato", "idle"],
  queued: ["In coda", "idle"],
  running: ["In corso", "work"],
  waiting_node: ["Attende il nodo", "work"],
  done: ["Fatto", "ok"],
  blocked: ["Bloccato", "ko"],
  failed: ["Fallito", "ko"],
  cancelled: ["Annullato", "idle"],
};

/** Stato di un compito del PLAN o di una sua esecuzione. */
export function TaskStatusBadge({ status }: { status: TeamPlanTaskStatus | TeamTaskStatus }) {
  const [label, style] = WORK[status];
  return <StatusBadge label={label} style={style} />;
}

const TURN: Record<TeamTurnStatus, [string, LedState]> = {
  queued: ["In coda", "idle"],
  running: ["In corso", "work"],
  done: ["Concluso", "ok"],
  failed: ["Fallito", "ko"],
};

export function TurnStatusBadge({ status }: { status: TeamTurnStatus }) {
  const [label, style] = TURN[status];
  return <StatusBadge label={label} style={style} />;
}

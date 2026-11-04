import type { TeamPlanStatus, TeamPlanTaskStatus, TeamTaskStatus, TeamTurnStatus } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Stati del lavoro di una squadra: PLAN, compiti del PLAN, esecuzioni dei compiti e turni del capo.

const MUTED = "bg-muted text-muted-foreground";
const AMBER = "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
const BLUE = "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300";
const GREEN = "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
const RED = "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300";
const VIOLET = "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300";

function StatusBadge({ label, style, className }: { label: string; style: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", style, className)}>
      {label}
    </Badge>
  );
}

const PLAN: Record<TeamPlanStatus, [string, string]> = {
  draft: ["Bozza", AMBER],
  proposed: ["Proposto", BLUE],
  approved: ["Approvato", GREEN],
};

export function PlanStatusBadge({ status }: { status: TeamPlanStatus }) {
  const [label, style] = PLAN[status];
  return <StatusBadge label={label} style={style} />;
}

const WORK: Record<TeamPlanTaskStatus | TeamTaskStatus, [string, string]> = {
  planned: ["Pianificato", MUTED],
  queued: ["In coda", MUTED],
  running: ["In corso", BLUE],
  waiting_node: ["Attende il nodo", VIOLET],
  done: ["Fatto", GREEN],
  blocked: ["Bloccato", AMBER],
  failed: ["Fallito", RED],
  cancelled: ["Annullato", MUTED],
};

/** Stato di un compito del PLAN o di una sua esecuzione. */
export function TaskStatusBadge({ status }: { status: TeamPlanTaskStatus | TeamTaskStatus }) {
  const [label, style] = WORK[status];
  return <StatusBadge label={label} style={style} />;
}

const TURN: Record<TeamTurnStatus, [string, string]> = {
  queued: ["In coda", MUTED],
  running: ["In corso", BLUE],
  done: ["Concluso", GREEN],
  failed: ["Fallito", RED],
};

export function TurnStatusBadge({ status }: { status: TeamTurnStatus }) {
  const [label, style] = TURN[status];
  return <StatusBadge label={label} style={style} />;
}

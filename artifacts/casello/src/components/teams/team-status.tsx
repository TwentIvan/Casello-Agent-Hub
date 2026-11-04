import type { TeamInstanceStatus } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const TEAM_STATUS_LABELS: Record<TeamInstanceStatus, string> = {
  draft: "Bozza",
  active: "Attiva",
  closed: "Chiusa",
};

const STYLES: Record<TeamInstanceStatus, string> = {
  draft: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  closed: "bg-muted text-muted-foreground",
};

/** Stato di una squadra: bozza, attiva o chiusa (non si riapre). */
export function TeamStatusBadge({ status, className }: { status: TeamInstanceStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", STYLES[status], className)}>
      {TEAM_STATUS_LABELS[status]}
    </Badge>
  );
}

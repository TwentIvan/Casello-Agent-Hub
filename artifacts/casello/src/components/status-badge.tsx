import type { AgentStatus, AppStatus } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const APP_STATUS_LABELS: Record<AppStatus, string> = {
  active: "Attiva",
  inactive: "Inattiva",
};

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  active: "Attivo",
  inactive: "Inattivo",
  draft: "Bozza",
};

const STYLES: Record<AgentStatus, string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  inactive: "bg-muted text-muted-foreground",
  draft: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

type StatusBadgeProps =
  | { kind: "app"; status: AppStatus; className?: string }
  | { kind: "agent"; status: AgentStatus; className?: string };

/** Stato di App (attiva / inattiva) e Agenti (attivo / inattivo / bozza). */
export function StatusBadge({ kind, status, className }: StatusBadgeProps) {
  const label = kind === "app" ? APP_STATUS_LABELS[status as AppStatus] : AGENT_STATUS_LABELS[status];
  return (
    <Badge variant="outline" className={cn("border-transparent", STYLES[status], className)}>
      {label}
    </Badge>
  );
}

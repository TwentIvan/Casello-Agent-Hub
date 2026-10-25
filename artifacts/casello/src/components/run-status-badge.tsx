import type { RunStatus } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  pending: "In attesa",
  running: "In corso",
  succeeded: "Riuscita",
  failed: "Fallita",
  awaiting_client: "In attesa di conferma",
  cancelled: "Annullata",
};

const STYLES: Record<RunStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  awaiting_client: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  cancelled: "bg-muted text-muted-foreground",
};

export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", STYLES[status], className)}>
      {RUN_STATUS_LABELS[status]}
    </Badge>
  );
}

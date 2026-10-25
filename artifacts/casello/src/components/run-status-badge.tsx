import type { RunStatus } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  pending: "In attesa",
  running: "In corso",
  succeeded: "Riuscita",
  failed: "Fallita",
};

const STYLES: Record<RunStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", STYLES[status], className)}>
      {RUN_STATUS_LABELS[status]}
    </Badge>
  );
}

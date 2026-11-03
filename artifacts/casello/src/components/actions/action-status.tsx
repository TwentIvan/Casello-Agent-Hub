import type { QueuedActionStatus } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const ACTION_STATUS_LABELS: Record<QueuedActionStatus, string> = {
  pending: "In attesa",
  executing: "In esecuzione",
  done: "Eseguita",
  failed: "Fallita",
  rejected: "Rifiutata",
};

const STYLES: Record<QueuedActionStatus, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  executing: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  rejected: "bg-muted text-muted-foreground",
};

export function ActionStatusBadge({ status, className }: { status: QueuedActionStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", STYLES[status], className)}>
      {ACTION_STATUS_LABELS[status]}
    </Badge>
  );
}

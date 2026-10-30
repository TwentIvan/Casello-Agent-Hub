import type { ItemIssue } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const OPEN = "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
const COMPLETED = "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300";
const NOT_PLANNED = "bg-muted text-muted-foreground";

/** Issue GitHub collegata a una voce: «#12 aperta» (verde) o «#12 chiusa» (viola, grigia se non pianificata). */
export function IssueBadge({ issue }: { issue: ItemIssue }) {
  const open = issue.state === "open";
  const style = open ? OPEN : issue.stateReason !== "not_planned" ? COMPLETED : NOT_PLANNED;
  return (
    <a href={issue.url} target="_blank" rel="noopener noreferrer" title={`Apri la issue su ${issue.repo}`}>
      <Badge variant="outline" className={cn("border-transparent", style)}>
        #{issue.number} {open ? "aperta" : "chiusa"}
      </Badge>
    </a>
  );
}

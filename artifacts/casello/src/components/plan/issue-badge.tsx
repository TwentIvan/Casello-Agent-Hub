import type { ItemIssue } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const OPEN = "border-border text-ink";
const COMPLETED = "border-border text-success";
const NOT_PLANNED = "border-border text-ink-muted";

/** Issue GitHub collegata a una voce: «#12 aperta» (verde) o «#12 chiusa» (verde se completata, grigia se non pianificata). */
export function IssueBadge({ issue }: { issue: ItemIssue }) {
  const open = issue.state === "open";
  const style = open ? OPEN : issue.stateReason !== "not_planned" ? COMPLETED : NOT_PLANNED;
  return (
    <a href={issue.url} target="_blank" rel="noopener noreferrer" title={`Apri la issue su ${issue.repo}`}>
      <Badge variant="outline" className={cn("font-mono", style)}>
        #{issue.number} {open ? "aperta" : "chiusa"}
      </Badge>
    </a>
  );
}

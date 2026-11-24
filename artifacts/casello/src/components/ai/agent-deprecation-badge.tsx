import { Link } from "wouter";
import type { AgentModelDeprecation } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { deprecationLabel, replacementText } from "@/lib/agent-deprecations";
import { cn } from "@/lib/utils";

/** Avviso sul modello di un agente dal catalogo (ritirato / in dismissione) con il sostituto proposto nel tooltip. */
export function AgentDeprecationBadge({ item, href, className }: { item: AgentModelDeprecation; href?: string; className?: string }) {
  const el = (
    <Badge variant="outline" className={cn("border-border", item.retired ? "text-danger" : "text-accent-text", className)}>
      {deprecationLabel(item)}
    </Badge>
  );
  const title = `${deprecationLabel(item)}: ${replacementText(item)}`;
  return href ? (
    <Link href={href} className="relative z-10" title={`${title}. Cambia il modello dell'agente`}>
      {el}
    </Link>
  ) : (
    <span title={title}>{el}</span>
  );
}

import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAiModelGroups } from "./ai-queries";
import { deprecationBadge } from "./model-deprecation";

const STYLES = {
  retired: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  soon: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

/** Avviso sul modello dell'agente (ritirato / in dismissione); nulla se non serve. `href` porta a dove si cambia. */
export function ModelDeprecationBadge({ aiModelId, href, className }: { aiModelId: number | null; href?: string; className?: string }) {
  const groups = useAiModelGroups();
  if (aiModelId === null) return null;
  const model = groups.data?.flatMap((g) => g.models).find((m) => m.id === aiModelId);
  const badge = deprecationBadge(model, new Date());
  if (!badge) return null;
  const el = (
    <Badge variant="outline" className={cn("border-transparent", STYLES[badge.tone], className)}>
      {badge.label}
    </Badge>
  );
  return href ? (
    <Link href={href} className="relative z-10" title="Cambia il modello dell'agente">
      {el}
    </Link>
  ) : (
    el
  );
}

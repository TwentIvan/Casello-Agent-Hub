import type { SkillKind } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";

export const SKILL_KIND_LABELS: Record<SkillKind, string> = {
  casello: "Casello",
  node: "Nodo locale",
};

/** Tipo di una skill: istruzioni salvate in Casello o skill installata sul nodo locale. */
export function SkillKindBadge({ kind }: { kind: SkillKind }) {
  return <Badge variant="outline">{SKILL_KIND_LABELS[kind]}</Badge>;
}

/** Suggerimenti sugli strumenti: "a, b" ⇄ ["a", "b"] (senza vuoti né ripetizioni). */
export function parseToolHints(text: string): string[] {
  return [...new Set(text.split(",").map((h) => h.trim()).filter(Boolean))];
}

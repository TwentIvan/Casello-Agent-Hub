import { useMemo, useState } from "react";
import type { AnalysisItem } from "@workspace/api-client-react";

/** Massimo di voci per richiesta di creazione (limite dell'API). */
export const MAX_ISSUES_PER_REQUEST = 30;

/** Voce del piano da cui si può creare una issue: approvata e non ancora collegata. */
export function canCreateIssue(item: AnalysisItem): boolean {
  return item.status === "approved" && item.issue === null;
}

/**
 * Voci del piano selezionate per creare le issue. La selezione resta limitata alle voci idonee: una voce
 * collegata dopo la creazione (o non più approvata) ne esce da sola alla rilettura del piano.
 */
export function useIssueSelection(items: AnalysisItem[]) {
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());

  const eligibleIds = useMemo(() => items.filter(canCreateIssue).map((i) => i.id), [items]);
  const selectedIds = useMemo(() => eligibleIds.filter((id) => picked.has(id)), [eligibleIds, picked]);
  const eligible = useMemo(() => new Set(eligibleIds), [eligibleIds]);

  const toggle = (id: number, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return {
    isEligible: (id: number) => eligible.has(id),
    isSelected: (id: number) => picked.has(id) && eligible.has(id),
    eligibleCount: eligibleIds.length,
    selectedIds,
    toggle,
    /** Seleziona le approvate senza issue, fino al massimo per richiesta. */
    selectAll: () => setPicked(new Set(eligibleIds.slice(0, MAX_ISSUES_PER_REQUEST))),
    clear: () => setPicked(new Set()),
  };
}

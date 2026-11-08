import { useMemo, useState } from "react";
import type { QueuedAction } from "@workspace/api-client-react";
import { dependentsOf } from "@/lib/proposal-steps";

/**
 * Scelta dei passi di una proposta in attesa: passi esclusi, saltati a catena, etichetta del pulsante e corpo
 * dell'approvazione. Condivisa da `PendingActionItem` e `ActionDialog`.
 */
export function useProposalSelection(action: Pick<QueuedAction, "kind" | "proposal"> | null) {
  const proposal = action?.kind === "proposal" ? action.proposal : null;
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const skipped = useMemo(
    () => (proposal ? dependentsOf(proposal.steps, excluded) : new Set<string>()),
    [proposal, excluded],
  );
  const nothingLeft = proposal !== null && proposal.steps.every((s) => excluded.has(s.key) || skipped.has(s.key));
  const toggle = (key: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return {
    proposal,
    excluded,
    toggle,
    nothingLeft,
    approveLabel: excluded.size > 0 ? "Approva i passi scelti" : "Approva",
    approveData: (): { escludi?: string[] } => (excluded.size > 0 ? { escludi: [...excluded] } : {}),
  };
}

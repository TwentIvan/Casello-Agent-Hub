import { useMemo } from "react";
import {
  ApiError,
  useDecideCharacterInstructionProposal,
  type CharacterInstructionProposal,
} from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { lineDiff } from "@/lib/architecture";
import { instructionCardState } from "@/lib/instruction-proposals";

/** Scheda di una proposta di istruzioni personali: motivazione, confronto con il testo attuale, «Accetta» / «Rifiuta». */
export function InstructionProposalCard({
  proposal,
  readOnly,
  onDecided,
}: {
  proposal: CharacterInstructionProposal;
  readOnly: boolean;
  onDecided: () => void;
}) {
  const { toast } = useToast();
  const state = instructionCardState(proposal);
  const name = proposal.character === "alfred" ? "Alfred" : "Lucius";
  const diff = useMemo(() => lineDiff(proposal.currentContent, proposal.content), [proposal.currentContent, proposal.content]);
  const decide = useDecideCharacterInstructionProposal({
    mutation: {
      onSuccess: (_r, vars) => {
        toast({ title: vars.data.action === "accept" ? `Istruzioni di ${name} aggiornate` : "Proposta rifiutata" });
        onDecided();
      },
      onError: (error) => {
        // Su 409 la scheda è già decisa o superata: si rilegge per mostrarne lo stato vero
        if (error instanceof ApiError && error.status === 409) onDecided();
        toast({ variant: "destructive", title: "Decisione non riuscita", description: apiErrorMessage(error) });
      },
    },
  });

  return (
    <div className="min-w-0 space-y-2 rounded-md border border-border bg-surface-1 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-label">Istruzioni personali di {name}</p>
        <Led state={state.led} label={state.label} />
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{proposal.reason}</p>
      <div className="min-w-0 rounded-md border border-border bg-surface-2 p-2 font-mono text-xs">
        {diff.length === 0 && <span className="text-ink-muted">Testo vuoto</span>}
        {diff.map((line, index) => (
          <div
            key={index}
            className={
              "whitespace-pre-wrap [overflow-wrap:anywhere] " +
              (line.kind === "added" ? "text-success" : line.kind === "removed" ? "text-danger" : "text-ink-muted")
            }
          >
            {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
            {line.text}
          </div>
        ))}
      </div>
      {state.canDecide && !readOnly && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: proposal.id, data: { action: "accept" } })}
          >
            Accetta
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: proposal.id, data: { action: "reject" } })}
          >
            Rifiuta
          </Button>
        </div>
      )}
    </div>
  );
}

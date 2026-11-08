import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type QueuedAction,
  getGetDashboardStatsQueryKey,
  useApprovePendingAction,
  useRejectPendingAction,
} from "@workspace/api-client-react";
import { ConfirmItem } from "@/components/brand/confirm-item";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";
import { dependentsOf } from "@/lib/proposal-steps";
import { ACTION_KIND_LABELS, isPlanItem } from "./plan-proposal";
import { ProposalSteps } from "./proposal-steps";

/** «Azione n. 3 approvata», «Piano n. 4 rifiutato», «Modifica del piano n. 5 approvata». */
export function decidedTitle(action: QueuedAction, approved: boolean): string {
  const masculine = action.kind === "plan";
  const ending = masculine ? (approved ? "approvato" : "rifiutato") : approved ? "approvata" : "rifiutata";
  return `${ACTION_KIND_LABELS[action.kind]} n. ${action.number} ${ending}`;
}

/** Serve la scheda per approvare: un piano va letto per intero, uno strumento con identità utente vuole il token. */
export function needsDialogToApprove(action: QueuedAction): boolean {
  return isPlanItem(action) || (action.kind === "action" && action.tool?.identity === "user");
}

/**
 * Voce in attesa della pagina «Da confermare»: decisione diretta con ConfirmItem. «Approva» apre la scheda quando la
 * voce va letta per intero o chiede il token dell'utente; «Dettagli» la apre sempre.
 * Nel pannello incorporato (`consoleHref`) non c'è la scheda: quelle voci si approvano nella console («Apri in Botcave»,
 * nuova scheda) e «Dettagli» non compare; «Rifiuta» con nota resta per tutte.
 */
export function PendingActionItem({
  action,
  onOpenDetails,
  onDecided,
  consoleHref,
}: {
  action: QueuedAction;
  onDecided: () => void;
} & (
  | { onOpenDetails: () => void; consoleHref?: undefined }
  | {
      onOpenDetails?: undefined;
      /** Indirizzo della pagina «Da confermare» della console (pannello incorporato). */
      consoleHref: string;
    }
)) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const proposal = action.kind === "proposal" ? action.proposal : null;
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
  const after = () => {
    void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
    onDecided();
  };
  const approve = useApprovePendingAction({
    mutation: {
      onSuccess: (saved) => {
        toast({ title: decidedTitle(saved, true), description: saved.result ?? saved.errorMessage ?? undefined });
        after();
      },
      onError: (error) => {
        toast({ variant: "destructive", title: "Approvazione non riuscita", description: apiErrorMessage(error) });
        after();
      },
    },
  });
  const reject = useRejectPendingAction({
    mutation: {
      onSuccess: (saved) => {
        toast({ title: decidedTitle(saved, false) });
        after();
      },
      onError: (error) => {
        toast({ variant: "destructive", title: "Rifiuto non riuscito", description: apiErrorMessage(error) });
        after();
      },
    },
  });
  const busy = approve.isPending || reject.isPending;
  const meta = [action.team?.name, action.app?.name, `in coda ${formatRelative(action.createdAt)}`]
    .filter(Boolean)
    .join(" · ");
  const plan = isPlanItem(action);
  const toConsole = consoleHref !== undefined && needsDialogToApprove(action);

  return (
    <ConfirmItem
      number={action.number}
      title={proposal ? proposal.title : action.summary}
      meta={meta}
      summary={
        proposal ? (
          <>
            {proposal.reason && <span className="block whitespace-pre-wrap">{proposal.reason}</span>}
            <span className="block">Destinatario: {action.recipient}</span>
          </>
        ) : plan ? (
          <>
            {ACTION_KIND_LABELS[action.kind]} proposto dal capo della squadra:{" "}
            {consoleHref !== undefined ? "aprilo in Botcave" : "apri i dettagli"} per leggerlo prima di decidere.
          </>
        ) : (
          <>
            Destinatario: {action.recipient}
            {action.tool && (
              <>
                {" · "}strumento <span className="font-mono text-xs">{action.tool.name}</span>
              </>
            )}
          </>
        )
      }
      note={note}
      onNoteChange={setNote}
      busy={busy}
      approveDisabled={nothingLeft}
      approveLabel={
        plan
          ? "Leggi e approva"
          : approve.isPending
            ? "Esecuzione…"
            : excluded.size > 0
              ? "Approva i passi scelti"
              : "Approva"
      }
      rejectLabel={reject.isPending ? "Rifiuto…" : "Rifiuta"}
      onApprove={() => {
        if (needsDialogToApprove(action)) return onOpenDetails?.();
        const escludi = [...excluded];
        approve.mutate({ number: action.number, data: escludi.length ? { escludi } : {} });
      }}
      onReject={() => reject.mutate({ number: action.number, data: note.trim() ? { note: note.trim() } : {} })}
      approveSlot={
        toConsole ? (
          <Button asChild>
            <a href={consoleHref} target="_blank" rel="noopener">
              Apri in Botcave
            </a>
          </Button>
        ) : undefined
      }
      extraActions={
        onOpenDetails ? (
          <Button variant="ghost" size="sm" onClick={onOpenDetails} disabled={busy}>
            Dettagli
          </Button>
        ) : undefined
      }
    >
      {proposal && <ProposalSteps proposal={proposal} excluded={excluded} onToggle={toggle} />}
    </ConfirmItem>
  );
}

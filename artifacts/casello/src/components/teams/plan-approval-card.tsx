import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type QueuedAction,
  type TeamInstance,
  getGetDashboardStatsQueryKey,
  getGetTeamPlanQueryKey,
  getListPendingActionsQueryKey,
  getListTeamTurnsQueryKey,
  useApprovePendingAction,
  useListPendingActions,
  useRejectPendingAction,
} from "@workspace/api-client-react";
import { ACTION_KIND_LABELS, PlanProposalDetail, isPlanItem } from "@/components/actions/plan-proposal";
import { ConfirmItem } from "@/components/brand/confirm-item";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

const PENDING = { status: "pending" } as const;

function Proposal({ team, item, onDecided }: { team: TeamInstance; item: QueuedAction; onDecided: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const roleName = (key: string) => team.roles.find((r) => r.key === key)?.name ?? key;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getListPendingActionsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetTeamPlanQueryKey(team.id) });
    void queryClient.invalidateQueries({ queryKey: getListTeamTurnsQueryKey(team.id) });
    // La decisione accoda un turno del capo: il polling riparte per il periodo di grazia
    onDecided();
  };
  const approve = useApprovePendingAction({
    mutation: {
      onSuccess: () => {
        toast({ title: item.kind === "plan" ? "Piano approvato" : "Modifica del piano approvata" });
        refresh();
      },
      onError: (error) => {
        toast({ variant: "destructive", title: "Approvazione non riuscita", description: apiErrorMessage(error) });
        refresh();
      },
    },
  });
  const reject = useRejectPendingAction({
    mutation: {
      onSuccess: () => {
        toast({ title: item.kind === "plan" ? "Piano rifiutato" : "Modifica del piano rifiutata" });
        refresh();
      },
      onError: (error) => {
        toast({ variant: "destructive", title: "Rifiuto non riuscito", description: apiErrorMessage(error) });
        refresh();
      },
    },
  });
  const busy = approve.isPending || reject.isPending;

  return (
    <ConfirmItem
      number={item.number}
      title={item.kind === "plan" ? "Piano da approvare" : "Modifica del piano da approvare"}
      meta={`${ACTION_KIND_LABELS[item.kind]} proposto dal capo · ${formatRelative(item.createdAt)}`}
      summary={item.summary}
      note={note}
      onNoteChange={setNote}
      busy={busy}
      approveLabel={approve.isPending ? "Approvazione…" : "Approva"}
      rejectLabel={reject.isPending ? "Rifiuto…" : "Rifiuta"}
      onApprove={() => approve.mutate({ number: item.number, data: {} })}
      onReject={() => reject.mutate({ number: item.number, data: note.trim() ? { note: note.trim() } : {} })}
    >
      <PlanProposalDetail args={item.args} roleName={roleName} />
    </ConfirmItem>
  );
}

/**
 * Riquadri «Piano da approvare»: le voci `plan`/`plan_change` della squadra in attesa nella coda di chi l'ha attivata
 * (per gli altri utenti l'elenco è vuoto e non compare nulla).
 */
export function PlanApprovalCards({
  team,
  poll,
  onDecided,
}: {
  team: TeamInstance;
  poll: number | false;
  onDecided: () => void;
}) {
  const list = useListPendingActions(PENDING, {
    query: { queryKey: getListPendingActionsQueryKey(PENDING), refetchInterval: poll },
  });
  const items = (list.data?.actions ?? []).filter((a) => a.team?.id === team.id && isPlanItem(a));
  if (items.length === 0) return null;
  return (
    <>
      {items.map((item) => (
        <Proposal key={item.number} team={team} item={item} onDecided={onDecided} />
      ))}
    </>
  );
}

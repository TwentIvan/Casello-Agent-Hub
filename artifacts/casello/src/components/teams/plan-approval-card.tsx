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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

const PENDING = { status: "pending" } as const;

function Proposal({ team, item, onDecided }: { team: TeamInstance; item: QueuedAction; onDecided: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
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
    <Card className="border-amber-300 dark:border-amber-800">
      <CardHeader>
        <CardTitle className="text-base">
          {item.kind === "plan" ? "Piano da approvare" : "Modifica del piano da approvare"}
        </CardTitle>
        <CardDescription className="break-words">
          {ACTION_KIND_LABELS[item.kind]} n. {item.number} · proposto {formatRelative(item.createdAt)}. {item.summary}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <PlanProposalDetail args={item.args} roleName={roleName} />
        {rejecting && (
          <div className="space-y-1.5">
            <Label htmlFor={`plan-reject-note-${item.number}`}>Nota per il capo (facoltativa)</Label>
            <Textarea
              id={`plan-reject-note-${item.number}`}
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Cosa cambiare nel piano"
            />
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {rejecting ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
                Annulla
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  reject.mutate({ number: item.number, data: note.trim() ? { note: note.trim() } : {} })
                }
              >
                {reject.isPending ? "Rifiuto…" : "Rifiuta"}
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
              Rifiuta con nota
            </Button>
          )}
          <Button disabled={busy} onClick={() => approve.mutate({ number: item.number, data: {} })}>
            {approve.isPending ? "Approvazione…" : "Approva"}
          </Button>
        </div>
      </CardContent>
    </Card>
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

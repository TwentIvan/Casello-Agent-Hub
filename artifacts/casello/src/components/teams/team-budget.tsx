import { useQueryClient } from "@tanstack/react-query";
import {
  type TeamInstance,
  getGetTeamInstanceQueryKey,
  getListTeamInstancesQueryKey,
  useSetTeamBudget,
} from "@workspace/api-client-react";
import { CapForm } from "@/components/budget/budget";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

/** Tetto mensile di turni e compiti della squadra (vuoto = nessun tetto). */
export function TeamBudgetCard({ team, dirty }: { team: TeamInstance; dirty: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const closed = team.status === "closed";
  const update = useSetTeamBudget({
    mutation: {
      onSuccess: (saved) => {
        queryClient.setQueryData(getGetTeamInstanceQueryKey(saved.id), saved);
        void queryClient.invalidateQueries({ queryKey: getListTeamInstancesQueryKey() });
        toast({ title: saved.monthlyBudgetUsd === null ? "Tetto di spesa tolto" : "Tetto di spesa salvato" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Tetto non salvato", description: apiErrorMessage(error) }),
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Tetto di spesa</CardTitle>
        <CardDescription>
          Spesa del mese di turni del capo e compiti della squadra. Raggiunto il tetto, turni e compiti non partono fino
          al mese prossimo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <CapForm
          key={String(team.monthlyBudgetUsd)}
          value={team.monthlyBudgetUsd}
          pending={update.isPending}
          disabled={closed || dirty}
          label="Tetto mensile della squadra in USD"
          onSave={(monthlyBudgetUsd) => update.mutate({ id: team.id, data: { monthlyBudgetUsd } })}
        />
        {closed ? (
          <p className="text-sm text-muted-foreground">La squadra è chiusa: il tetto non si cambia più.</p>
        ) : (
          dirty && <p className="text-sm text-muted-foreground">Salva le modifiche alla squadra prima di cambiare il tetto.</p>
        )}
      </CardContent>
    </Card>
  );
}

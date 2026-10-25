import { useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import {
  ApiError,
  type Run,
  type RunDecision,
  getGetDashboardStatsQueryKey,
  getGetRunQueryKey,
  getListRunStepsQueryKey,
  getListRunsQueryKey,
  useResumeRun,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

/** Scheda di una run in pausa: conferma o annulla l'azione proposta dall'agente. */
export function ConfirmationCard({ run }: { run: Run }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const pending = run.pendingAction;

  const refresh = () => {
    for (const queryKey of [getGetRunQueryKey(run.id), getListRunStepsQueryKey(run.id), getListRunsQueryKey(), getGetDashboardStatsQueryKey()]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
  const resume = useResumeRun({
    mutation: {
      onSuccess: (updated) => {
        queryClient.setQueryData(getGetRunQueryKey(run.id), updated);
        refresh();
      },
      onError: (error) => {
        toast({
          variant: "destructive",
          title: error instanceof ApiError && error.status === 409 ? "Azione non più in attesa" : "Operazione non riuscita",
          description: apiErrorMessage(error),
        });
        // Con un 409 la run è già cambiata (scaduta o già decisa): si riallinea la pagina.
        refresh();
      },
    },
  });

  if (!pending) return null;
  const decide = (decision: RunDecision) => resume.mutate({ id: run.id, data: { decision } });

  if (pending.kind === "ui") {
    return (
      <Card className="border-amber-300">
        <CardHeader>
          <CardTitle className="text-base">Azione sull'interfaccia</CardTitle>
          <CardDescription>{pending.summary}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Verrà gestita dal widget dell'app: da qui non c'è nulla da confermare.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-amber-300">
      <CardHeader>
        <CardTitle className="text-base">Conferma richiesta</CardTitle>
        <CardDescription>
          L'agente vuole eseguire <span className="font-mono">{pending.toolName}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{pending.summary}</p>
        <pre className="max-h-60 overflow-auto rounded bg-muted p-2 font-mono text-xs">
          {JSON.stringify(pending.args, null, 2)}
        </pre>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="outline" disabled={resume.isPending} onClick={() => decide("rejected")}>
          <X />
          Annulla
        </Button>
        <Button disabled={resume.isPending} onClick={() => decide("approved")}>
          <Check />
          Conferma
        </Button>
      </CardFooter>
    </Card>
  );
}

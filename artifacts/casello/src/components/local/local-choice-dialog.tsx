import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type LocalJob,
  type LocalJobChoiceInputChoice,
  getEstimateAnalysisCostQueryKey,
  getListLocalJobsQueryKey,
  useChooseLocalJob,
  useEstimateAnalysisCost,
  useListLocalJobs,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatUsd } from "@/lib/format";

const POLL_MS = 2000;

/** Lavori aperti dell'utente con l'agente locale, ricaricati a intervallo (anche per vedere un lavoro in attesa). */
export function useLocalJobs(enabled = true, intervalMs: number | false = POLL_MS) {
  return useListLocalJobs({
    query: { queryKey: getListLocalJobsQueryKey(), enabled, refetchInterval: enabled ? intervalMs : false },
  });
}

/** Applica una scelta a un lavoro (riserva, attendi, posticipa) e ricarica elenco lavori e analisi/run. */
export function useChooseJob(onChosen?: (choice: LocalJobChoiceInputChoice) => void) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useChooseLocalJob({
    mutation: {
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({ queryKey: getListLocalJobsQueryKey() });
        // La scelta cambia lo stato di analisi e run (chiavi sotto /api/runs e /api/apps/:id/analyses)
        void queryClient.invalidateQueries({
          predicate: ({ queryKey }) =>
            typeof queryKey[0] === "string" && (queryKey[0].startsWith("/api/runs") || queryKey[0].includes("/analyses")),
        });
        onChosen?.(variables.data.choice);
      },
      onError: (error) => {
        // Il 409 arriva se la scelta è già stata fatta altrove (altra scheda, scadenza)
        void queryClient.invalidateQueries({ queryKey: getListLocalJobsQueryKey() });
        toast({ variant: "destructive", title: "Scelta non applicata", description: apiErrorMessage(error) });
      },
    },
  });
}

function FallbackEstimate({ job }: { job: LocalJob }) {
  const params = { aiModelId: job.fallbackAiModelId ?? 0 };
  const estimate = useEstimateAnalysisCost(params, {
    query: {
      queryKey: getEstimateAnalysisCostQueryKey(params),
      enabled: job.kind === "analysis" && job.fallbackAiModelId !== null,
      staleTime: 60_000,
    },
  });
  if (job.kind !== "analysis" || !estimate.data) return null;
  return (
    <span className="block text-xs text-muted-foreground">
      {estimate.data.typicalUsd != null && estimate.data.maxUsd != null
        ? `stima: circa ${formatUsd(estimate.data.typicalUsd)} (massimo ${formatUsd(estimate.data.maxUsd)})`
        : "costo non stimabile: prezzi del modello sconosciuti"}
    </span>
  );
}

/**
 * Finestra "L'agente locale non è collegato": compare quando il lavoro di un'analisi o di una run appena
 * avviata va in `waiting_choice` (polling di GET /local/jobs filtrato per id). Se si chiude senza scegliere,
 * il lavoro resta nell'elenco dei lavori in attesa.
 */
export function LocalChoiceDialog({ analysisId, runId }: { analysisId?: number; runId?: number }) {
  const [dismissed, setDismissed] = useState<number | null>(null);
  const jobs = useLocalJobs(analysisId !== undefined || runId !== undefined);
  const job = jobs.data?.find(
    (j) =>
      j.status === "waiting_choice" &&
      (analysisId !== undefined ? j.analysisId === analysisId : j.runId === runId),
  );
  const choose = useChooseJob();
  if (!job) return null;

  const pick = (choice: LocalJobChoiceInputChoice) => choose.mutate({ id: job.id, data: { choice } });
  const isAnalysis = job.kind === "analysis";
  const hasFallback = job.fallbackAiModelId !== null;

  return (
    <Dialog open={dismissed !== job.id} onOpenChange={(open) => !open && setDismissed(job.id)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>L'agente locale non è collegato</DialogTitle>
          <DialogDescription>
            Il runner della macchina scelta non risponde. Cosa vuoi fare {isAnalysis ? "con l'analisi" : "con la run"}?
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-3 text-sm">
          <li className="space-y-1">
            <Button className="w-full" disabled={!hasFallback || choose.isPending} onClick={() => pick("fallback")}>
              Usa il modello di riserva
            </Button>
            {hasFallback ? (
              <FallbackEstimate job={job} />
            ) : (
              <span className="block text-xs text-muted-foreground">Nessun modello di riserva impostato.</span>
            )}
          </li>
          <li className="space-y-1">
            <Button variant="outline" className="w-full" disabled={choose.isPending} onClick={() => pick("wait")}>
              Attendi
            </Button>
            <span className="block text-xs text-muted-foreground">
              Resta in coda fino a {isAnalysis ? "30 minuti" : "2 minuti"}: se il runner si collega parte da solo,
              altrimenti fallisce.
            </span>
          </li>
          <li className="space-y-1">
            <Button variant="outline" className="w-full" disabled={choose.isPending} onClick={() => pick("postpone")}>
              Posticipa
            </Button>
            <span className="block text-xs text-muted-foreground">
              Parte da solo appena un runner si collega, entro 24 ore, poi viene annullato.
            </span>
          </li>
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDismissed(job.id)}>
            Decido dopo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

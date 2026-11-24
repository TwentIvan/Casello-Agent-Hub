import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Agent,
  type AgentModelEvaluationSuggestionsItem,
  getGetAgentModelEvaluationQueryKey,
  getGetAgentQueryKey,
  getListAgentsQueryKey,
  useGetAgentModelEvaluation,
  useUpdateAgent,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatModelPrice, formatUsd } from "@/lib/format";
import { evidenceLabel, formatRate, toolErrorsLabel } from "@/lib/model-evaluation";

/**
 * Valutazione del modello (issue #112): ultime run dell'agente e modelli con strumenti più economici dei propri account, con la
 * stima del risparmio. «Usa questo modello» cambia il modello dell'agente dopo una conferma.
 */
export function AgentModelEvaluationCard({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const evaluation = useGetAgentModelEvaluation(agent.id, {
    query: { queryKey: getGetAgentModelEvaluationQueryKey(agent.id) },
  });
  // Resta valorizzato a dialog chiuso: titolo e toast non perdono il nome durante l'animazione
  const [choice, setChoice] = useState<AgentModelEvaluationSuggestionsItem | null>(null);
  const [open, setOpen] = useState(false);

  const updateAgent = useUpdateAgent({
    mutation: {
      onSuccess: (saved) => {
        queryClient.setQueryData(getGetAgentQueryKey(saved.id), saved);
        void queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetAgentModelEvaluationQueryKey(agent.id) });
        toast({ title: "Modello cambiato", description: choice?.name });
        setOpen(false);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Cambio del modello non riuscito", description: apiErrorMessage(error) }),
    },
  });

  const data = evaluation.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Valutazione del modello</CardTitle>
        <CardDescription>
          Ultime run concluse dell'agente e modelli con strumenti più economici dei tuoi account, a parità di successo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {evaluation.isError ? (
          <p className="text-sm text-destructive">Impossibile calcolare la valutazione: {apiErrorMessage(evaluation.error)}</p>
        ) : evaluation.isLoading || !data ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-label text-ink-muted">Run lette</dt>
                <dd className="font-mono">
                  {data.usage.runs} di {data.usage.runsInWindow} in {data.windowDays} giorni
                </dd>
              </div>
              <div>
                <dt className="text-label text-ink-muted">Successo</dt>
                <dd className="font-mono">{formatRate(data.usage.successRate)}</dd>
              </div>
              <div>
                <dt className="text-label text-ink-muted">Errori dei tool</dt>
                <dd className="font-mono">{toolErrorsLabel(data.usage.toolCalls, data.usage.toolErrors)}</dd>
              </div>
              <div>
                <dt className="text-label text-ink-muted">Costo per run</dt>
                <dd className="font-mono">
                  {data.currentModel?.estimatedCostPerRunUsd != null
                    ? `${formatUsd(data.currentModel.estimatedCostPerRunUsd)} stimato`
                    : data.usage.avgCostUsd != null
                      ? formatUsd(data.usage.avgCostUsd)
                      : "n.d."}
                </dd>
              </div>
            </dl>
            <p className="text-sm text-ink-muted">{data.note}</p>
            {data.suggestions.length > 0 && (
              <ul className="divide-y rounded-md border">
                {data.suggestions.map((s) => (
                  <li key={s.aiModelId} className="flex flex-wrap items-start justify-between gap-3 p-3">
                    <div className="min-w-0 space-y-1">
                      <div className="font-mono text-sm font-medium break-all">{s.name}</div>
                      <div className="text-xs text-ink-muted">
                        {s.accountName} · {formatModelPrice(s.priceInput, s.priceOutput)}
                      </div>
                      <div className="text-sm">
                        {formatUsd(s.estimatedCostPerRunUsd)} per run, risparmio {formatUsd(s.savingPerRunUsd)} ({s.savingPercent} %),
                        circa {formatUsd(s.estimatedMonthlySavingUsd)} al mese
                      </div>
                      <div className="text-xs text-ink-muted">{evidenceLabel(s.observedRuns, s.observedSuccessRate)}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setChoice(s);
                        setOpen(true);
                      }}
                    >
                      Usa questo modello
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Usare «${choice?.name ?? ""}» per «${agent.name}»?`}
        description="Le prossime run partiranno con questo modello e saranno pagate dal suo account. La stima vale per run simili a quelle lette."
        confirmLabel="Usa questo modello"
        pendingLabel="Cambio in corso…"
        pending={updateAgent.isPending}
        onConfirm={() => choice && updateAgent.mutate({ id: agent.id, data: { aiModelId: choice.aiModelId } })}
      />
    </Card>
  );
}

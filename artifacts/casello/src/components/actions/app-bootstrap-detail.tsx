import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAppBootstrapQueryKey,
  getGetPendingActionQueryKey,
  useGetAppBootstrap,
  useRetryAppBootstrap,
} from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatUsd } from "@/lib/format";
import { readBootstrapArgs } from "@/lib/app-bootstrap";

/** Voce «Nuova app»: nomi, dominio, i quattro passi e la stima dell'analisi; se è fallita, il passo fallito con «Riprova». */
export function AppBootstrapDetail({ args, status, number }: { args: unknown; status: string; number?: number }) {
  const a = readBootstrapArgs(args);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const showState = status === "failed" && a.bootstrapId !== null;
  const boot = useGetAppBootstrap(a.bootstrapId ?? 0, {
    query: { queryKey: getGetAppBootstrapQueryKey(a.bootstrapId ?? 0), enabled: showState },
  });
  const failedStep = boot.data?.steps.find((s) => s.status === "failed") ?? null;
  const retry = useRetryAppBootstrap({
    mutation: {
      onSuccess: () => {
        if (a.bootstrapId !== null) void queryClient.invalidateQueries({ queryKey: getGetAppBootstrapQueryKey(a.bootstrapId) });
        if (number !== undefined) void queryClient.invalidateQueries({ queryKey: getGetPendingActionQueryKey(number) });
        toast({ title: "Ripresa avviata" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Ripresa non riuscita", description: apiErrorMessage(error) }),
    },
  });

  return (
    <div className="space-y-2 text-sm">
      <p className="break-words">
        <span className="font-medium">{a.name}</span> · <span className="font-mono">{a.slug}</span> ·{" "}
        <span className="font-mono">{a.domain}</span> · <span className="font-mono">{a.repo}</span>
      </p>
      <ol className="list-decimal space-y-0.5 pl-5">
        {a.steps.map((s, i) => (
          <li key={i} className="break-words">
            {s}
          </li>
        ))}
      </ol>
      {a.analysisEstimateUsd !== null && (
        <p>
          Stima dell'analisi: fino a <span className="font-mono">{formatUsd(a.analysisEstimateUsd)}</span>
        </p>
      )}
      {a.monthly && <p className="text-ink-muted">{a.monthly}</p>}
      {failedStep && (
        <div className="space-y-2 rounded-md border border-border p-2">
          <Led state="ko" label={`Passo fallito: ${failedStep.key}`} />
          {failedStep.message && <p className="break-words text-danger">{failedStep.message}</p>}
          {a.bootstrapId !== null && (
            <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate({ id: a.bootstrapId! })}>
              {retry.isPending ? "Ripresa…" : "Riprova"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

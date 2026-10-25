import { useEffect, useRef } from "react";
import { Bot, Check, Wrench, X } from "lucide-react";
import { type Run, type RunStep, getListRunStepsQueryKey, useListRunSteps } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatDuration } from "@/lib/format";
import { isRunActive } from "./run-queries";

const POLL_MS = 1500;

function StepRow({ step }: { step: RunStep }) {
  const isTool = step.type === "tool";
  const failed = step.ok === false;
  const hasArgs = step.args != null && Object.keys(step.args).length > 0;
  return (
    <li className="space-y-1 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{step.position + 1}</span>
        {isTool ? <Wrench className="size-4 text-muted-foreground" /> : <Bot className="size-4 text-muted-foreground" />}
        <span className="font-medium">{isTool ? "Tool" : "Modello"}</span>
        {step.toolName && <span className="font-mono text-xs">{step.toolName}</span>}
        {step.ok != null && (
          <Badge
            variant="outline"
            className={
              failed
                ? "border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                : "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
            }
          >
            {failed ? <X className="size-3" /> : <Check className="size-3" />}
            {failed ? "Errore" : "Ok"}
          </Badge>
        )}
        {step.httpStatus != null && (
          <Badge variant="outline" className="font-mono text-[11px]">
            HTTP {step.httpStatus}
          </Badge>
        )}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatDuration(step.durationMs)}</span>
      </div>
      {step.error && <p className="pl-8 text-xs text-destructive break-words">{step.error}</p>}
      {hasArgs && (
        <details className="pl-8 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Argomenti</summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 font-mono">
            {JSON.stringify(step.args, null, 2)}
          </pre>
        </details>
      )}
    </li>
  );
}

/** Timeline dei passi di una run (chiamate al modello e ai tool), ricaricata finché la run è attiva. */
export function RunSteps({ run }: { run: Run }) {
  const active = isRunActive(run);
  const steps = useListRunSteps(run.id, {
    query: {
      queryKey: getListRunStepsQueryKey(run.id),
      refetchInterval: active ? POLL_MS : false,
    },
  });
  // Quando lo stato della run cambia (pausa, ripresa, fine) si ricaricano subito anche i passi.
  const lastStatus = useRef(run.status);
  const { refetch } = steps;
  useEffect(() => {
    if (lastStatus.current !== run.status) {
      lastStatus.current = run.status;
      void refetch();
    }
  }, [run.status, refetch]);

  if (steps.isLoading) return <Skeleton className="h-16 w-full" />;
  if (steps.isError && !steps.data) {
    return <p className="text-sm text-destructive">Impossibile caricare i passi: {apiErrorMessage(steps.error)}</p>;
  }
  if (!steps.data?.length) {
    // Nessun passo: per le run senza tool non c'è nulla da mostrare.
    return null;
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Passi ({steps.data.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="divide-y">
          {steps.data.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

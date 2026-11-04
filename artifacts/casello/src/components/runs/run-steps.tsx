import { useEffect, useRef } from "react";
import { Link } from "wouter";
import { Bot, Check, Wrench, X } from "lucide-react";
import {
  type Run,
  type RunStep,
  getGetPendingActionQueryKey,
  getListRunStepsQueryKey,
  useGetPendingAction,
  useListRunSteps,
} from "@workspace/api-client-react";
import { ActionStatusBadge } from "@/components/actions/action-status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatDuration } from "@/lib/format";
import { isRunActive } from "./run-queries";

const POLL_MS = 1500;

/** Passo di una run o di un turno/compito di una squadra: stessa forma di `run_steps`. */
export type StepView = Pick<RunStep, "id" | "position" | "type" | "toolName" | "ok" | "httpStatus" | "durationMs" | "error"> & {
  args?: unknown;
};

/** Numero e sintesi di un passo `queued` (args = { numero, destinatario, sintesi, argomenti }). */
function queuedInfo(step: StepView): { numero: number | null; sintesi: string | null; argomenti: unknown } {
  const a = (step.args ?? {}) as Record<string, unknown>;
  return {
    numero: typeof a.numero === "number" ? a.numero : null,
    sintesi: typeof a.sintesi === "string" ? a.sintesi : null,
    argomenti: a.argomenti,
  };
}

/** Collegamento alla voce della coda con il suo stato attuale (riletto a ogni apertura della pagina). */
function QueuedLink({ numero }: { numero: number }) {
  const action = useGetPendingAction(numero, { query: { queryKey: getGetPendingActionQueryKey(numero) } });
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Link href="/pending-actions" className="font-medium hover:underline">
        Accodata n. {numero}
      </Link>
      {action.data && <ActionStatusBadge status={action.data.status} />}
    </span>
  );
}

function StepRow({ step }: { step: StepView }) {
  // `queued`: azione L2 accodata per la conferma (args = numero, destinatario, sintesi, argomenti)
  const isTool = step.type === "tool" || step.type === "queued";
  const failed = step.ok === false;
  const queued = step.type === "queued" ? queuedInfo(step) : null;
  const shownArgs = queued ? queued.argomenti : step.args;
  const hasArgs = shownArgs != null && typeof shownArgs === "object" && Object.keys(shownArgs as object).length > 0;
  return (
    <li className="space-y-1 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{step.position + 1}</span>
        {isTool ? <Wrench className="size-4 text-muted-foreground" /> : <Bot className="size-4 text-muted-foreground" />}
        {queued?.numero != null ? (
          <QueuedLink numero={queued.numero} />
        ) : (
          <span className="font-medium">{step.type === "queued" ? "Accodata" : isTool ? "Tool" : "Modello"}</span>
        )}
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
      {queued?.sintesi && <p className="pl-8 text-xs text-muted-foreground break-words">{queued.sintesi}</p>}
      {hasArgs && (
        <details className="pl-8 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Argomenti</summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 font-mono">
            {JSON.stringify(shownArgs, null, 2)}
          </pre>
        </details>
      )}
    </li>
  );
}

/** Elenco dei passi (chiamate al modello e agli strumenti), già caricati. */
export function StepList({ steps }: { steps: StepView[] }) {
  return (
    <ol className="divide-y">
      {steps.map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
    </ol>
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
        <StepList steps={steps.data} />
      </CardContent>
    </Card>
  );
}

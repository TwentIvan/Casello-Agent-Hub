import { useEffect, useRef } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft } from "lucide-react";
import {
  ApiError,
  getGetAgentQueryKey,
  getGetDashboardStatsQueryKey,
  getGetRunQueryKey,
  getListRunsQueryKey,
  useGetAgent,
  useGetRun,
} from "@workspace/api-client-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { RunStatusBadge } from "@/components/run-status-badge";
import { isRunActive } from "@/components/runs/run-queries";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatDuration, formatRelative } from "@/lib/format";

const POLL_MS = 1500;

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "medium" });
}

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const runId = Number(params.id);
  const queryClient = useQueryClient();

  const run = useGetRun(runId, {
    query: {
      queryKey: getGetRunQueryKey(runId),
      enabled: Number.isInteger(runId),
      // Polling solo finché la run è in attesa o in corso.
      refetchInterval: (query) => (query.state.data && isRunActive(query.state.data) ? POLL_MS : false),
    },
  });
  const agentId = run.data?.agentId ?? 0;
  const agent = useGetAgent(agentId, { query: { queryKey: getGetAgentQueryKey(agentId), enabled: agentId > 0 } });

  // Quando la run finisce, liste e statistiche altrove sono da aggiornare.
  const wasActive = useRef(false);
  const active = run.data ? isRunActive(run.data) : false;
  useEffect(() => {
    if (wasActive.current && !active) {
      void queryClient.invalidateQueries({ queryKey: getListRunsQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
    }
    wasActive.current = active;
  }, [active, queryClient]);

  const backLink = (
    <Link href="/runs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" />
      Run
    </Link>
  );

  if (!Number.isInteger(runId) || (run.error instanceof ApiError && run.error.status === 404)) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        {backLink}
        <p className="text-sm text-muted-foreground">Run non trovata: potrebbe essere stata eliminata con il suo agente.</p>
      </div>
    );
  }
  if (run.isError && !run.data) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        {backLink}
        <p className="text-sm text-destructive">Impossibile caricare la run: {apiErrorMessage(run.error)}</p>
      </div>
    );
  }
  if (!run.data) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        {backLink}
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const r = run.data;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-3">
        {backLink}
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">Run #{r.id}</h2>
          <RunStatusBadge status={r.status} />
        </div>
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Agente</dt>
            <dd>
              <Link href={`/agents/${r.agentId}`} className="font-medium hover:underline">
                {agent.data?.name ?? `Agente #${r.agentId}`}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Avviata</dt>
            <dd title={formatDateTime(r.createdAt)}>{formatRelative(r.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Conclusa</dt>
            <dd>{r.finishedAt ? formatDateTime(r.finishedAt) : "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Durata</dt>
            <dd className="tabular-nums">{formatDuration(r.durationMs)}</dd>
          </div>
        </dl>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Input</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap text-sm">{r.input || "—"}</p>
        </CardContent>
      </Card>

      {active ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
            <Spinner className="size-5" />
            {r.status === "pending" ? "In attesa di partire…" : "L'agente sta lavorando…"}
          </CardContent>
        </Card>
      ) : r.status === "failed" ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Run fallita</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap break-words">
            {r.errorMessage || "Errore sconosciuto."}
          </AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Output</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{r.output || "—"}</div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

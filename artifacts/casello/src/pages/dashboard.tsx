import { useMemo } from "react";
import { Link } from "wouter";
import type { LucideIcon } from "lucide-react";
import { AlertCircle, Bot, Boxes, CheckCircle2, Clock, Loader, PlayCircle, XCircle } from "lucide-react";
import {
  getGetDashboardStatsQueryKey,
  getListAgentsQueryKey,
  getListRunsQueryKey,
  useGetDashboardStats,
  useListAgents,
  useListRuns,
} from "@workspace/api-client-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RunStatusBadge } from "@/components/run-status-badge";
import { BudgetAlerts } from "@/components/budget/budget";
import { formatDuration, formatRelative } from "@/lib/format";

// Le run durano da secondi a decine di secondi: aggiornamento periodico leggero.
const REFRESH_MS = 15_000;
const RECENT_RUNS = 5;

interface StatCardProps {
  label: string;
  value: string | number | undefined;
  hint?: string;
  icon: LucideIcon;
  loading: boolean;
}

function StatCard({ label, value, hint, icon: Icon, loading }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {loading ? <Skeleton className="h-8 w-16" /> : <div className="text-2xl font-semibold">{value}</div>}
        {hint && !loading && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function RecentRuns() {
  const params = { limit: RECENT_RUNS };
  const runs = useListRuns(params, {
    query: { queryKey: getListRunsQueryKey(params), refetchInterval: REFRESH_MS },
  });
  const agents = useListAgents(undefined, { query: { queryKey: getListAgentsQueryKey() } });

  const agentNames = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent.name])),
    [agents.data],
  );
  // L'API restituisce già le più recenti per prime.
  const recent = runs.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ultime run</CardTitle>
      </CardHeader>
      <CardContent>
        {runs.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare le run.</p>
        ) : runs.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nessuna run ancora. Le esecuzioni degli agenti compariranno qui.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agente</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead className="hidden md:table-cell">Input</TableHead>
                <TableHead className="text-right">Durata</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Avviata</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((run) => (
                <TableRow key={run.id} className="relative">
                  <TableCell className="font-medium">
                    {/* Il link copre tutta la riga (after:inset-0) */}
                    <Link href={`/runs/${run.id}`} className="after:absolute after:inset-0 hover:underline">
                      {agentNames.get(run.agentId) ?? `Agente #${run.agentId}`}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <RunStatusBadge status={run.status} />
                  </TableCell>
                  <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell">
                    {run.input || "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {formatDuration(run.durationMs)}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-right text-muted-foreground sm:table-cell">
                    {formatRelative(run.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const stats = useGetDashboardStats({
    query: { queryKey: getGetDashboardStatsQueryKey(), refetchInterval: REFRESH_MS },
  });
  const s = stats.data;
  const loading = stats.isLoading;
  const inProgress = s ? s.totalRuns - s.successfulRuns - s.failedRuns - s.cancelledRuns : undefined;

  return (
    <div className="mx-auto max-w-screen-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-sm text-muted-foreground">Panoramica delle app, degli agenti e delle esecuzioni.</p>
      </div>

      <BudgetAlerts />

      {stats.isError && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Statistiche non disponibili</AlertTitle>
          <AlertDescription>Non è stato possibile contattare l'API. Riprova tra poco.</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatCard label="App" value={s?.totalApps} icon={Boxes} loading={loading} />
        <StatCard
          label="Agenti"
          value={s?.totalAgents}
          hint={s ? `${s.activeAgents} attivi` : undefined}
          icon={Bot}
          loading={loading}
        />
        <StatCard
          label="Durata media run"
          value={formatDuration(s?.avgDurationMs)}
          icon={Clock}
          loading={loading}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Run totali" value={s?.totalRuns} icon={PlayCircle} loading={loading} />
        <StatCard label="Riuscite" value={s?.successfulRuns} icon={CheckCircle2} loading={loading} />
        <StatCard label="Fallite" value={s?.failedRuns} icon={XCircle} loading={loading} />
        <StatCard label="In attesa o in corso" value={inProgress} icon={Loader} loading={loading} />
      </div>

      <RecentRuns />
    </div>
  );
}

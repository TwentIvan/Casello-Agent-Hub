import { useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  type ListRunsParams,
  RunStatus,
  getListAgentsQueryKey,
  getListRunsQueryKey,
  useListAgents,
  useListRuns,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LocalJobsList } from "@/components/local/local-jobs-list";
import { RUN_STATUS_LABELS, RunStatusBadge } from "@/components/run-status-badge";
import { listRefetchInterval } from "@/components/runs/run-queries";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatDuration, formatRelative } from "@/lib/format";

const ALL = "all";

export default function RunsPage() {
  // I filtri stanno nell'URL (?agentId=&status=): la scheda agente linka qui già filtrata.
  const search = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const agentFilter = search.get("agentId") ?? ALL;
  const statusFilter = search.get("status") ?? ALL;

  const setFilter = (key: "agentId" | "status", value: string) => {
    const next = new URLSearchParams(search);
    if (value === ALL) next.delete(key);
    else next.set(key, value);
    const query = next.toString();
    navigate(query ? `/runs?${query}` : "/runs", { replace: true });
  };

  const params: ListRunsParams | undefined =
    agentFilter === ALL && statusFilter === ALL
      ? undefined
      : {
          ...(agentFilter !== ALL ? { agentId: Number(agentFilter) } : {}),
          ...(statusFilter !== ALL ? { status: statusFilter as RunStatus } : {}),
        };
  const runs = useListRuns(params, {
    query: {
      queryKey: getListRunsQueryKey(params),
      refetchInterval: (query) => listRefetchInterval(query.state.data),
    },
  });
  const agents = useListAgents(undefined, { query: { queryKey: getListAgentsQueryKey() } });

  const sortedAgents = useMemo(
    () => [...(agents.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "it")),
    [agents.data],
  );
  const agentNames = useMemo(() => new Map(sortedAgents.map((a) => [a.id, a.name])), [sortedAgents]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Run</h2>
        <p className="text-sm text-muted-foreground">Le esecuzioni degli agenti, dalla più recente.</p>
      </div>

      <LocalJobsList />

      <div className="flex flex-wrap gap-3">
        <Select value={agentFilter} onValueChange={(value) => setFilter("agentId", value)}>
          <SelectTrigger className="w-56" aria-label="Filtra per agente">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tutti gli agenti</SelectItem>
            {sortedAgents.map((agent) => (
              <SelectItem key={agent.id} value={String(agent.id)}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(value) => setFilter("status", value)}>
          <SelectTrigger className="w-44" aria-label="Filtra per stato">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tutti gli stati</SelectItem>
            {Object.values(RunStatus).map((status) => (
              <SelectItem key={status} value={status}>
                {RUN_STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {runs.isError ? (
            <p className="p-6 text-sm text-destructive">Impossibile caricare le run: {apiErrorMessage(runs.error)}</p>
          ) : runs.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !runs.data?.length ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              {params ? "Nessuna run corrisponde ai filtri." : "Nessuna run ancora: si lanciano dalla scheda di un agente."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16 pl-4">#</TableHead>
                  <TableHead>Agente</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead className="hidden md:table-cell">Input</TableHead>
                  <TableHead className="text-right">Durata</TableHead>
                  <TableHead className="hidden pr-4 text-right sm:table-cell">Avviata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.map((run) => (
                  <TableRow key={run.id} className="relative">
                    <TableCell className="pl-4 tabular-nums text-muted-foreground">
                      {/* Il link copre tutta la riga (after:inset-0) */}
                      <Link href={`/runs/${run.id}`} className="after:absolute after:inset-0 hover:underline">
                        {run.id}
                      </Link>
                    </TableCell>
                    <TableCell className="font-medium">{agentNames.get(run.agentId) ?? `Agente #${run.agentId}`}</TableCell>
                    <TableCell>
                      <RunStatusBadge status={run.status} />
                    </TableCell>
                    <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell">
                      {run.input || "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {formatDuration(run.durationMs)}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap pr-4 text-right text-muted-foreground sm:table-cell">
                      {formatRelative(run.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

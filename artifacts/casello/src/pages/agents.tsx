import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Plus } from "lucide-react";
import {
  type AgentStatus,
  getListAgentsQueryKey,
  getListAppsQueryKey,
  useListAgents,
  useListApps,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AgentCreateDialog } from "@/components/agents/agent-create-dialog";
import { ModelDeprecationBadge } from "@/components/ai/model-deprecation-badge";
import { AgentRoleBadge } from "@/components/agents/agent-role-badge";
import { AGENT_STATUS_LABELS, StatusBadge } from "@/components/status-badge";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

const ALL = "all";

export default function AgentsPage() {
  const [appFilter, setAppFilter] = useState<string>(ALL);
  const [statusFilter, setStatusFilter] = useState<AgentStatus | typeof ALL>(ALL);
  const [createKey, setCreateKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const appId = appFilter === ALL ? undefined : Number(appFilter);
  const params = appId ? { appId } : undefined;
  const agents = useListAgents(params, { query: { queryKey: getListAgentsQueryKey(params) } });
  const apps = useListApps({ query: { queryKey: getListAppsQueryKey() } });

  const sortedApps = useMemo(
    () => [...(apps.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "it")),
    [apps.data],
  );
  const appNames = useMemo(() => new Map(sortedApps.map((app) => [app.id, app.name])), [sortedApps]);
  // Il filtro per app lo fa l'API, quello per stato si applica qui.
  const visible = useMemo(
    () =>
      (agents.data ?? [])
        .filter((agent) => statusFilter === ALL || agent.status === statusFilter)
        .sort((a, b) => a.name.localeCompare(b.name, "it")),
    [agents.data, statusFilter],
  );
  const hasApps = sortedApps.length > 0;

  const openCreate = () => {
    setCreateKey((key) => key + 1);
    setCreateOpen(true);
  };

  return (
    <div className="mx-auto max-w-screen-2xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Agenti</h2>
          <p className="text-sm text-muted-foreground">Gli agenti configurati sulle app, con istruzioni e strumenti.</p>
        </div>
        <Button onClick={openCreate} disabled={!hasApps} title={hasApps ? undefined : "Registra prima un'app"}>
          <Plus />
          Nuovo agente
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <Select value={appFilter} onValueChange={setAppFilter}>
          <SelectTrigger className="w-48" aria-label="Filtra per app">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tutte le app</SelectItem>
            {sortedApps.map((app) => (
              <SelectItem key={app.id} value={String(app.id)}>
                {app.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as AgentStatus | typeof ALL)}>
          <SelectTrigger className="w-40" aria-label="Filtra per stato">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tutti gli stati</SelectItem>
            {Object.entries(AGENT_STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {agents.isError ? (
            <p className="p-6 text-sm text-destructive">Impossibile caricare gli agenti: {apiErrorMessage(agents.error)}</p>
          ) : agents.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">
                {!hasApps && !apps.isLoading
                  ? "Per creare un agente serve prima un'app."
                  : (agents.data?.length ?? 0) > 0
                    ? "Nessun agente corrisponde ai filtri."
                    : "Nessun agente ancora."}
              </p>
              {!hasApps && !apps.isLoading ? (
                <Button asChild variant="outline" size="sm">
                  <Link href="/apps">Vai alle app</Link>
                </Button>
              ) : (agents.data?.length ?? 0) === 0 ? (
                <Button variant="outline" size="sm" onClick={openCreate}>
                  <Plus />
                  Crea il primo agente
                </Button>
              ) : null}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Nome</TableHead>
                  <TableHead>App</TableHead>
                  <TableHead>Ruolo</TableHead>
                  <TableHead className="hidden md:table-cell">Modello</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead className="hidden pr-4 text-right lg:table-cell">Aggiornato</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((agent) => (
                  <TableRow key={agent.id} className="relative">
                    <TableCell className="pl-4 font-medium">
                      {/* Il link copre tutta la riga (after:inset-0) */}
                      <Link href={`/agents/${agent.id}`} className="after:absolute after:inset-0 hover:underline">
                        {agent.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {appNames.get(agent.appId) ?? `App #${agent.appId}`}
                    </TableCell>
                    <TableCell>
                      <AgentRoleBadge agent={agent} />
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                      <div className="flex flex-wrap items-center gap-2">
                        {agent.aiModelId === null ? (
                          <span className="text-amber-800 dark:text-amber-300">nessun modello</span>
                        ) : (
                          <span>{agent.model}</span>
                        )}
                        <ModelDeprecationBadge aiModelId={agent.aiModelId} href={`/agents/${agent.id}`} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge kind="agent" status={agent.status} />
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap pr-4 text-right text-muted-foreground lg:table-cell">
                      {formatRelative(agent.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AgentCreateDialog
        key={createKey}
        open={createOpen}
        onOpenChange={setCreateOpen}
        apps={sortedApps}
        defaultAppId={appId}
      />
    </div>
  );
}

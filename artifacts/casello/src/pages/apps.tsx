import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import {
  type App,
  getGetDashboardStatsQueryKey,
  getListAgentsQueryKey,
  getListAppsQueryKey,
  getListRunsQueryKey,
  useDeleteApp,
  useListAgents,
  useListApps,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AppFormDialog } from "@/components/apps/app-form-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { StatusBadge } from "@/components/status-badge";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

function agentsLabel(count: number): string {
  return count === 1 ? "1 agente" : `${count} agenti`;
}

export default function AppsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const apps = useListApps({ query: { queryKey: getListAppsQueryKey() } });
  const agents = useListAgents(undefined, { query: { queryKey: getListAgentsQueryKey() } });

  // Il dialog del form si rimonta a ogni apertura (key) per ripartire dai valori giusti.
  const [form, setForm] = useState<{ open: boolean; app?: App; key: number }>({ open: false, key: 0 });
  const [toDelete, setToDelete] = useState<App | null>(null);

  const agentCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const agent of agents.data ?? []) counts.set(agent.appId, (counts.get(agent.appId) ?? 0) + 1);
    return counts;
  }, [agents.data]);

  const sortedApps = useMemo(
    () => [...(apps.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "it")),
    [apps.data],
  );

  const deleteApp = useDeleteApp({
    mutation: {
      onSuccess: (_data, { id }) => {
        const name = apps.data?.find((app) => app.id === id)?.name;
        // L'eliminazione è a cascata: cambiano anche agenti, run e statistiche.
        for (const queryKey of [
          getListAppsQueryKey(),
          getListAgentsQueryKey(),
          getListRunsQueryKey(),
          getGetDashboardStatsQueryKey(),
        ]) {
          void queryClient.invalidateQueries({ queryKey });
        }
        toast({ title: "App eliminata", description: name });
        setToDelete(null);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Eliminazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  const openForm = (app?: App) => setForm((prev) => ({ open: true, app, key: prev.key + 1 }));
  const deleteCount = toDelete ? (agentCounts.get(toDelete.id) ?? 0) : 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">App</h2>
          <p className="text-sm text-muted-foreground">Le applicazioni registrate, che gli agenti possono chiamare.</p>
        </div>
        <Button onClick={() => openForm()}>
          <Plus />
          Nuova app
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {apps.isError ? (
            <p className="p-6 text-sm text-destructive">Impossibile caricare le app: {apiErrorMessage(apps.error)}</p>
          ) : apps.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : sortedApps.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">Nessuna app registrata.</p>
              <Button variant="outline" size="sm" onClick={() => openForm()}>
                <Plus />
                Registra la prima app
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Nome</TableHead>
                  <TableHead className="hidden md:table-cell">Base URL</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Agenti</TableHead>
                  <TableHead className="w-12 pr-4">
                    <span className="sr-only">Azioni</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedApps.map((app) => (
                  <TableRow key={app.id}>
                    <TableCell className="max-w-xs pl-4">
                      <div className="font-medium">{app.name}</div>
                      {app.description && (
                        <div className="truncate text-xs text-muted-foreground">{app.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="hidden max-w-xs truncate font-mono text-xs text-muted-foreground md:table-cell">
                      {app.baseUrl}
                    </TableCell>
                    <TableCell>
                      <StatusBadge kind="app" status={app.status} />
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">
                      {agents.isLoading ? "…" : (agentCounts.get(app.id) ?? 0)}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Azioni per ${app.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => openForm(app)}>
                            <Pencil />
                            Modifica
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => setToDelete(app)}
                          >
                            <Trash2 />
                            Elimina
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AppFormDialog
        key={form.key}
        open={form.open}
        app={form.app}
        onOpenChange={(open) => setForm((prev) => ({ ...prev, open }))}
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={`Eliminare «${toDelete?.name ?? ""}»?`}
        description={`${
          deleteCount > 0 ? `Verranno eliminati anche ${agentsLabel(deleteCount)}, con i loro strumenti e tutte le run. ` : ""
        }L'operazione non si può annullare.`}
        pending={deleteApp.isPending}
        onConfirm={() => toDelete && deleteApp.mutate({ id: toDelete.id })}
      />
    </div>
  );
}

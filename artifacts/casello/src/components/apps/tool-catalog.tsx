import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, MoreHorizontal, Pencil, Plus, Power, Trash2 } from "lucide-react";
import {
  type AppTool,
  getListAgentsQueryKey,
  getListAppToolsQueryKey,
  useDeleteAppTool,
  useListAppTools,
  useUpdateAppTool,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
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
import { AppToolDialog, TOOL_IDENTITY_LABELS, TOOL_STATUS_LABELS } from "@/components/apps/app-tool-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<AppTool["status"], string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  disabled: "bg-muted text-muted-foreground",
  draft: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

function endpointOf(tool: AppTool): string {
  const { method, path } = tool.definition as { method?: unknown; path?: unknown };
  return typeof method === "string" && typeof path === "string" ? `${method} ${path}` : "—";
}

export function ToolCatalog({ appId }: { appId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const tools = useListAppTools(appId, { query: { queryKey: getListAppToolsQueryKey(appId) } });

  // Il dialog si rimonta a ogni apertura (key) per ripartire dai valori giusti.
  const [form, setForm] = useState<{ open: boolean; tool?: AppTool; key: number }>({ open: false, key: 0 });
  const [toDelete, setToDelete] = useState<AppTool | null>(null);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: getListAppToolsQueryKey(appId) });

  const updateTool = useUpdateAppTool({
    mutation: {
      onSuccess: (saved) => {
        invalidate();
        toast({ title: saved.status === "active" ? "Tool attivato" : "Tool disattivato", description: saved.name });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Aggiornamento non riuscito", description: apiErrorMessage(error) }),
    },
  });
  const deleteTool = useDeleteAppTool({
    mutation: {
      onSuccess: (_data, { toolId }) => {
        invalidate();
        // Gli agenti perdono il tool assegnato: si aggiornano anche loro.
        void queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
        toast({ title: "Tool eliminato", description: tools.data?.find((t) => t.id === toolId)?.name });
        setToDelete(null);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Eliminazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  const openForm = (tool?: AppTool) => setForm((prev) => ({ open: true, tool, key: prev.key + 1 }));
  const sorted = [...(tools.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "it"));

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Catalogo dei tool</h3>
          <p className="text-sm text-muted-foreground">Le operazioni dell'app che gli agenti possono eseguire.</p>
        </div>
        <Button size="sm" onClick={() => openForm()}>
          <Plus />
          Nuovo tool
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {tools.isError ? (
            <p className="p-6 text-sm text-destructive">Impossibile caricare i tool: {apiErrorMessage(tools.error)}</p>
          ) : tools.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">Nessun tool nel catalogo.</p>
              <Button variant="outline" size="sm" onClick={() => openForm()}>
                <Plus />
                Aggiungi il primo tool
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Nome</TableHead>
                  <TableHead className="hidden sm:table-cell">Tipo</TableHead>
                  <TableHead className="hidden md:table-cell">Chiamata</TableHead>
                  <TableHead className="hidden lg:table-cell">Identità</TableHead>
                  <TableHead className="hidden lg:table-cell">Conferma</TableHead>
                  <TableHead className="hidden lg:table-cell">Sola lettura</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead className="w-12 pr-4">
                    <span className="sr-only">Azioni</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((tool) => (
                  <TableRow key={tool.id}>
                    <TableCell className="max-w-xs pl-4">
                      <div className="font-mono text-sm font-medium">{tool.name}</div>
                      {tool.description && (
                        <div className="truncate text-xs text-muted-foreground">{tool.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{tool.kind}</TableCell>
                    <TableCell className="hidden max-w-xs truncate font-mono text-xs md:table-cell">
                      {endpointOf(tool)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">{TOOL_IDENTITY_LABELS[tool.identity]}</TableCell>
                    <TableCell className="hidden lg:table-cell">{tool.requiresConfirmation ? "Sì" : "No"}</TableCell>
                    <TableCell className="hidden lg:table-cell">{tool.readOnly ? "Sì" : "No"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("border-transparent", STATUS_STYLES[tool.status])}>
                        {TOOL_STATUS_LABELS[tool.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Azioni per ${tool.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => openForm(tool)}>
                            {tool.kind === "http" ? <Pencil /> : <Eye />}
                            {tool.kind === "http" ? "Modifica" : "Dettagli"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              updateTool.mutate({
                                id: appId,
                                toolId: tool.id,
                                data: { status: tool.status === "active" ? "disabled" : "active" },
                              })
                            }
                          >
                            <Power />
                            {tool.status === "active" ? "Disattiva" : "Attiva"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => setToDelete(tool)}
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

      <AppToolDialog
        key={form.key}
        appId={appId}
        open={form.open}
        tool={form.tool}
        onOpenChange={(open) => setForm((prev) => ({ ...prev, open }))}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={`Eliminare «${toDelete?.name ?? ""}»?`}
        description="Il tool sparisce dal catalogo e dagli agenti che lo usano. L'operazione non si può annullare."
        pending={deleteTool.isPending}
        onConfirm={() => toDelete && deleteTool.mutate({ id: appId, toolId: toDelete.id })}
      />
    </section>
  );
}

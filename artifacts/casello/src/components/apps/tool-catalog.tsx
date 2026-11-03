import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, MoreHorizontal, Pencil, Plus, Power, RefreshCw, Trash2 } from "lucide-react";
import {
  type AppTool,
  getListAgentsQueryKey,
  getGetAppQueryKey,
  getListAppToolsQueryKey,
  useDeleteAppTool,
  useGetApp,
  useListAppTools,
  useRefreshAppMcpTools,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AppToolDialog } from "@/components/apps/app-tool-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { TOOL_IDENTITY_LABELS, TOOL_LEVEL_LABELS, TOOL_STATUS_LABELS, overrideLevels } from "@/lib/tool-labels";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<AppTool["status"], string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  disabled: "bg-muted text-muted-foreground",
  draft: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

function endpointOf(tool: AppTool): string {
  const { method, path, mcpName } = tool.definition as { method?: unknown; path?: unknown; mcpName?: unknown };
  if (tool.kind === "mcp") return typeof mcpName === "string" ? `MCP ${mcpName}` : "MCP";
  return typeof method === "string" && typeof path === "string" ? `${method} ${path}` : "—";
}

export function ToolCatalog({ appId }: { appId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const tools = useListAppTools(appId, { query: { queryKey: getListAppToolsQueryKey(appId) } });
  const app = useGetApp(appId, { query: { queryKey: getGetAppQueryKey(appId) } });

  // Il dialog si rimonta a ogni apertura (key) per ripartire dai valori giusti.
  const [form, setForm] = useState<{ open: boolean; tool?: AppTool; key: number }>({ open: false, key: 0 });
  // toDelete resta valorizzato a dialog chiuso, così titolo e toast non perdono il nome durante l'animazione.
  const [toDelete, setToDelete] = useState<AppTool | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: getListAppToolsQueryKey(appId) });

  const updateTool = useUpdateAppTool({
    mutation: {
      onSuccess: (saved, variables) => {
        invalidate();
        const title =
          variables.data.levelOverride !== undefined
            ? "Livello aggiornato"
            : saved.status === "active"
              ? "Tool attivato"
              : "Tool disattivato";
        toast({ title, description: saved.name });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Aggiornamento non riuscito", description: apiErrorMessage(error) }),
    },
  });
  const refreshMcp = useRefreshAppMcpTools({
    mutation: {
      onSuccess: (result) => {
        invalidate();
        const parts = [
          `${result.added} nuovi (in bozza)`,
          `${result.updated} aggiornati`,
          `${result.disabled} disattivati`,
          `${result.unchanged} invariati`,
        ];
        toast({
          title: "Strumenti aggiornati",
          description:
            parts.join(", ") +
            (result.conflicts.length > 0
              ? `. Nomi in conflitto con tool non MCP, lasciati invariati: ${result.conflicts.join(", ")}`
              : ""),
        });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Aggiornamento non riuscito", description: apiErrorMessage(error) }),
    },
  });
  const deleteTool = useDeleteAppTool({
    mutation: {
      onSuccess: () => {
        invalidate();
        // Gli agenti perdono il tool assegnato: si aggiornano anche loro.
        void queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
        toast({ title: "Tool eliminato", description: toDelete?.name });
        setDeleteOpen(false);
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
        <div className="flex flex-wrap gap-2">
          {app.data?.mcpUrl && (
            <Button
              size="sm"
              variant="outline"
              disabled={refreshMcp.isPending}
              onClick={() => refreshMcp.mutate({ id: appId })}
            >
              <RefreshCw className={refreshMcp.isPending ? "animate-spin" : undefined} />
              {refreshMcp.isPending ? "Aggiornamento…" : "Aggiorna strumenti"}
            </Button>
          )}
          <Button size="sm" onClick={() => openForm()}>
            <Plus />
            Nuovo tool
          </Button>
        </div>
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
                  <TableHead className="hidden lg:table-cell">Livello</TableHead>
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
                    <TableCell className="hidden lg:table-cell">
                      <div className="space-y-1">
                        <Select
                          value={tool.levelOverride ?? "declared"}
                          disabled={updateTool.isPending || overrideLevels(tool.level).length === 0}
                          onValueChange={(value) =>
                            updateTool.mutate({
                              id: appId,
                              toolId: tool.id,
                              data: { levelOverride: value === "declared" ? null : (value as AppTool["level"]) },
                            })
                          }
                        >
                          <SelectTrigger className="h-8 w-44" aria-label={`Livello di ${tool.name}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="declared">
                              {tool.kind === "mcp" ? "Dichiarato" : "Proprio"}: {TOOL_LEVEL_LABELS[tool.level]}
                            </SelectItem>
                            {overrideLevels(tool.level).map((l) => (
                              <SelectItem key={l} value={l}>
                                Alzato a {TOOL_LEVEL_LABELS[l]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </TableCell>
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
                            disabled={updateTool.isPending}
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
                            onSelect={() => {
                              setToDelete(tool);
                              setDeleteOpen(true);
                            }}
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
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Eliminare «${toDelete?.name ?? ""}»?`}
        description="Il tool sparisce dal catalogo e dagli agenti che lo usano. L'operazione non si può annullare."
        pending={deleteTool.isPending}
        onConfirm={() => toDelete && deleteTool.mutate({ id: appId, toolId: toDelete.id })}
      />
    </section>
  );
}

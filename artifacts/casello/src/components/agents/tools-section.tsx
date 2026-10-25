import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Braces, Plus, Trash2 } from "lucide-react";
import { type Tool, getListToolsQueryKey, useDeleteTool, useListTools } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { ToolFormDialog } from "./tool-form-dialog";

export function ToolsSection({ agentId }: { agentId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const tools = useListTools(agentId, { query: { queryKey: getListToolsQueryKey(agentId) } });
  const [form, setForm] = useState({ open: false, key: 0 });
  const [toDelete, setToDelete] = useState<Tool | null>(null);

  const deleteTool = useDeleteTool({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListToolsQueryKey(agentId) });
        toast({ title: "Strumento eliminato", description: toDelete?.name });
        setToDelete(null);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Eliminazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Strumenti</CardTitle>
          <CardDescription>Le chiamate HTTP all'app che l'agente può usare.</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setForm((prev) => ({ open: true, key: prev.key + 1 }))}>
          <Plus />
          Aggiungi strumento
        </Button>
      </CardHeader>
      <CardContent className={tools.data?.length ? "p-0" : undefined}>
        {tools.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare gli strumenti: {apiErrorMessage(tools.error)}</p>
        ) : tools.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : !tools.data?.length ? (
          <p className="text-sm text-muted-foreground">Nessuno strumento: l'agente può solo rispondere con il modello.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Nome</TableHead>
                <TableHead>Chiamata</TableHead>
                <TableHead className="hidden sm:table-cell">Parametri</TableHead>
                <TableHead className="w-12 pr-6">
                  <span className="sr-only">Azioni</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.data.map((tool) => (
                <TableRow key={tool.id}>
                  <TableCell className="max-w-xs pl-6">
                    <div className="font-medium">{tool.name}</div>
                    {tool.description && <div className="text-xs text-muted-foreground">{tool.description}</div>}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono text-[11px]">
                        {tool.httpMethod}
                      </Badge>
                      <span className="break-all font-mono text-xs">{tool.endpoint}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {tool.parametersSchema ? (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-7 px-2">
                            <Braces />
                            Schema
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-96 max-w-[90vw]">
                          <pre className="max-h-80 overflow-auto font-mono text-xs">{tool.parametersSchema}</pre>
                        </PopoverContent>
                      </Popover>
                    ) : (
                      <span className="text-xs text-muted-foreground">Nessuno</span>
                    )}
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Elimina ${tool.name}`}
                      onClick={() => setToDelete(tool)}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <ToolFormDialog
        key={form.key}
        agentId={agentId}
        open={form.open}
        onOpenChange={(open) => setForm((prev) => ({ ...prev, open }))}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={`Eliminare lo strumento «${toDelete?.name ?? ""}»?`}
        description="L'agente non potrà più usarlo nelle prossime run."
        pending={deleteTool.isPending}
        onConfirm={() => toDelete && deleteTool.mutate({ agentId, toolId: toDelete.id })}
      />
    </Card>
  );
}

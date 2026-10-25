import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Agent,
  type AppTool,
  getGetAgentQueryKey,
  getListAgentsQueryKey,
  getListAppToolsQueryKey,
  useListAppTools,
  useSetAgentTools,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { TOOL_IDENTITY_LABELS, TOOL_STATUS_LABELS } from "@/components/apps/app-tool-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

function ToolBadges({ tool }: { tool: AppTool }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant="outline" className="text-[11px] font-normal">
        {TOOL_IDENTITY_LABELS[tool.identity]}
      </Badge>
      {tool.readOnly ? (
        <Badge variant="outline" className="text-[11px] font-normal">
          Sola lettura
        </Badge>
      ) : null}
      {tool.requiresConfirmation ? (
        <Badge variant="outline" className="text-[11px] font-normal">
          Chiede conferma
        </Badge>
      ) : null}
      {tool.status !== "active" ? (
        <Badge variant="secondary" className="text-[11px] font-normal">
          {TOOL_STATUS_LABELS[tool.status]}
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * Strumenti dell'agente. Il generale usa tutti i tool attivi dell'app (elenco in sola lettura);
 * un agente di area ha le caselle sui tool del catalogo (si assegnano solo quelli attivi).
 */
export function AgentToolsSection({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const tools = useListAppTools(agent.appId, { query: { queryKey: getListAppToolsQueryKey(agent.appId) } });
  const isGeneral = agent.role === "general";

  const sorted = useMemo(
    () => [...(tools.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "it")),
    [tools.data],
  );
  const [selected, setSelected] = useState<Set<number>>(() => new Set(agent.toolIds));
  // Si riallinea alla selezione salvata quando l'agente viene ricaricato (dopo il salvataggio).
  const savedKey = [...agent.toolIds].sort((a, b) => a - b).join(",");
  useEffect(() => {
    setSelected(new Set(agent.toolIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);
  const dirty = savedKey !== [...selected].sort((a, b) => a - b).join(",");

  const setTools = useSetAgentTools({
    mutation: {
      onSuccess: (saved) => {
        queryClient.setQueryData(getGetAgentQueryKey(saved.id), saved);
        void queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
        toast({ title: "Strumenti salvati" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  const toggle = (id: number, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const catalogLink = (
    <Link href={`/apps/${agent.appId}`} className="font-medium text-foreground hover:underline">
      catalogo dei tool dell'app
    </Link>
  );
  const visible = isGeneral ? sorted.filter((tool) => tool.status === "active") : sorted;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Strumenti</CardTitle>
        <CardDescription>
          {isGeneral ? (
            <>L'agente generale usa tutti i tool attivi del {catalogLink}.</>
          ) : (
            <>Scegli quali tool del {catalogLink} può usare questo agente. Si assegnano solo i tool attivi.</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {tools.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare i tool: {apiErrorMessage(tools.error)}</p>
        ) : tools.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {isGeneral ? "Nessun tool attivo nel catalogo dell'app." : "Il catalogo dell'app non ha ancora tool."}
          </p>
        ) : isGeneral ? (
          <ul className="divide-y">
            {visible.map((tool) => (
              <li key={tool.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="font-mono text-sm font-medium">{tool.name}</div>
                  {tool.description && <div className="text-xs text-muted-foreground">{tool.description}</div>}
                </div>
                <ToolBadges tool={tool} />
              </li>
            ))}
          </ul>
        ) : (
          <ul className="divide-y">
            {visible.map((tool) => {
              const assignable = tool.status === "active";
              const id = `agent-tool-${tool.id}`;
              return (
                <li key={tool.id} className="flex items-start gap-3 py-2">
                  <Checkbox
                    id={id}
                    className="mt-1"
                    // Un tool non più attivo già assegnato si può solo togliere.
                    disabled={!assignable && !selected.has(tool.id)}
                    checked={selected.has(tool.id)}
                    onCheckedChange={(checked) => toggle(tool.id, checked === true)}
                  />
                  <label htmlFor={id} className={assignable ? "min-w-0 flex-1" : "min-w-0 flex-1 opacity-70"}>
                    <span className="block font-mono text-sm font-medium">{tool.name}</span>
                    {tool.description && (
                      <span className="block text-xs text-muted-foreground">{tool.description}</span>
                    )}
                  </label>
                  <ToolBadges tool={tool} />
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      {!isGeneral && (
        <CardFooter className="justify-end gap-2">
          <Button
            variant="outline"
            disabled={!dirty || setTools.isPending}
            onClick={() => setSelected(new Set(agent.toolIds))}
          >
            Annulla modifiche
          </Button>
          <Button
            disabled={!dirty || setTools.isPending}
            onClick={() => setTools.mutate({ id: agent.id, data: { toolIds: [...selected] } })}
          >
            {setTools.isPending ? "Salvataggio…" : "Salva strumenti"}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

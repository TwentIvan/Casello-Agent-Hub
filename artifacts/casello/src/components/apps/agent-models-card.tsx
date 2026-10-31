import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { type Agent, getListAgentsQueryKey, useListAgents, useSetAppAgentModels } from "@workspace/api-client-react";
import { ModelDeprecationBadge } from "@/components/ai/model-deprecation-badge";
import { ModelPicker } from "@/components/ai/model-picker";
import { AgentRoleBadge } from "@/components/agents/agent-role-badge";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";

// Le chiavi delle query degli agenti (elenco, dettaglio, skill) iniziano tutte con /api/agents.
const isAgentsQuery = (query: Query) => {
  const head = query.queryKey[0];
  return typeof head === "string" && head.startsWith("/api/agents");
};

/** Mappa dei modelli degli agenti di un'app: scelta per riga, «Applica a tutti» e un solo salvataggio. */
export function AgentModelsCard({ appId }: { appId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const params = { appId };
  const agents = useListAgents(params, { query: { queryKey: getListAgentsQueryKey(params) } });
  // Modifiche non salvate: id dell'agente → modello scelto (null = nessuno)
  const [changes, setChanges] = useState<Map<number, number | null>>(new Map());
  const [bulkModel, setBulkModel] = useState<number | null | undefined>(undefined);

  const save = useSetAppAgentModels({
    mutation: {
      onSuccess: (saved) => {
        // Valori salvati subito nell'elenco, così le righe non tornano per un attimo ai vecchi modelli
        const byId = new Map(saved.map((agent) => [agent.id, agent]));
        queryClient.setQueryData<Agent[]>(getListAgentsQueryKey(params), (old) =>
          old?.map((agent) => byId.get(agent.id) ?? agent),
        );
        setChanges(new Map());
        void queryClient.invalidateQueries({ predicate: isAgentsQuery });
        toast({ title: saved.length === 1 ? "Modello salvato" : `Modelli salvati (${saved.length} agenti)` });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  const list = agents.data ?? [];
  const valueOf = (agentId: number, saved: number | null) => (changes.has(agentId) ? changes.get(agentId)! : saved);
  // Solo le righe davvero diverse dal valore salvato
  const assignments = list
    .filter((agent) => changes.has(agent.id) && changes.get(agent.id) !== agent.aiModelId)
    .map((agent) => ({ agentId: agent.id, aiModelId: changes.get(agent.id)! }));

  const setRow = (agentId: number, aiModelId: number | null) =>
    setChanges((prev) => new Map(prev).set(agentId, aiModelId));
  const applyToAll = () => setChanges(new Map(list.map((agent) => [agent.id, bulkModel ?? null])));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Modelli degli agenti</CardTitle>
        <CardDescription>Il modello con cui gira ciascun agente dell'app. Le run usano l'account del modello scelto.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {agents.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare gli agenti: {apiErrorMessage(agents.error)}</p>
        ) : !agents.data ? (
          <Skeleton className="h-24 w-full" />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessun agente in questa app.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-start gap-2">
              <div className="w-full max-w-md">
                <ModelPicker id={`agent-models-bulk-${appId}`} value={bulkModel ?? null} onChange={setBulkModel} allowNone />
              </div>
              <Button variant="outline" onClick={applyToAll} disabled={save.isPending || bulkModel === undefined}>
                Applica a tutti
              </Button>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agente</TableHead>
                  <TableHead>Ruolo</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead className="w-[45%]">Modello</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((agent) => {
                  const value = valueOf(agent.id, agent.aiModelId);
                  return (
                    <TableRow key={agent.id} className={cn(value === null && "bg-amber-50 dark:bg-amber-950/40")}>
                      <TableCell className="font-medium">
                        <Link href={`/agents/${agent.id}`} className="hover:underline">
                          {agent.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <AgentRoleBadge agent={agent} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge kind="agent" status={agent.status} />
                      </TableCell>
                      <TableCell className="space-y-1 whitespace-normal">
                        <ModelPicker
                          value={value}
                          onChange={(id) => setRow(agent.id, id)}
                          allowNone
                          disabled={save.isPending}
                          aria-invalid={value === null}
                        />
                        {value === null ? (
                          <p className="text-xs text-amber-800 dark:text-amber-300">nessun modello: le run non partono</p>
                        ) : (
                          <ModelDeprecationBadge aiModelId={value} />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={changes.size === 0 || save.isPending}
                onClick={() => setChanges(new Map())}
              >
                Annulla modifiche
              </Button>
              <Button
                disabled={assignments.length === 0 || save.isPending}
                onClick={() => save.mutate({ id: appId, data: { assignments } })}
              >
                {save.isPending ? "Salvataggio…" : "Salva"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Play } from "lucide-react";
import {
  type Agent,
  getGetBudgetQueryKey,
  getGetDashboardStatsQueryKey,
  getListRunsQueryKey,
  useListRuns,
  useTriggerRun,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RunStatusBadge } from "@/components/run-status-badge";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatDuration, formatRelative } from "@/lib/format";
import { listRefetchInterval } from "./run-queries";

const RECENT_RUNS = 5;

/** Lancio di una run dalla scheda agente, con le ultime run dello stesso agente. */
export function RunPanel({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [input, setInput] = useState("");
  // Token di prova dell'utente dell'app: vive solo nello stato della pagina, mai in storage.
  const [testToken, setTestToken] = useState("");

  const params = { agentId: agent.id, limit: 20 };
  const runs = useListRuns(params, {
    query: {
      queryKey: getListRunsQueryKey(params),
      refetchInterval: (query) => listRefetchInterval(query.state.data),
    },
  });

  const token = testToken.trim();
  const triggerRun = useTriggerRun({
    request: token ? { headers: { "X-App-User-Token": token } } : undefined,
    mutation: {
      onSuccess: (run) => {
        void queryClient.invalidateQueries({ queryKey: getListRunsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
        navigate(`/runs/${run.id}`);
      },
      onError: (error) => {
        toast({ variant: "destructive", title: "Run non avviata", description: apiErrorMessage(error) });
        // Un 409 può essere il tetto di spesa: il riepilogo aggiornato apre la finestra sulle run in corso
        void queryClient.invalidateQueries({ queryKey: getGetBudgetQueryKey() });
      },
    },
  });

  const canRun = input.trim().length > 0 && !triggerRun.isPending;
  const run = () => canRun && triggerRun.mutate({ id: agent.id, data: { input: input.trim() } });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Esegui</CardTitle>
        <CardDescription>
          Il task da affidare all'agente: la run parte subito e si apre la sua pagina.
          {agent.status !== "active" && " L'agente non è attivo, ma la run parte comunque."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Textarea
          rows={4}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // Ctrl/⌘ + Invio per eseguire senza staccare le mani dalla tastiera.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              run();
            }
          }}
          placeholder="es. Suggerisci la formazione per la prossima giornata"
          aria-label="Input della run"
        />
        <Collapsible className="rounded-md border">
          <CollapsibleTrigger className="group flex w-full items-center justify-between px-3 py-2 text-sm font-medium">
            Token di prova dell'app
            <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 border-t px-3 py-3">
            <Input
              type="password"
              autoComplete="new-password"
              value={testToken}
              onChange={(event) => setTestToken(event.target.value)}
              placeholder="Token dell'utente dell'app"
              aria-label="Token di prova dell'app"
            />
            <p className="text-xs text-muted-foreground">
              Serve ai tool che agiscono con l'identità dell'utente: viene inviato come X-App-User-Token solo con
              questa run. Resta nella pagina e non viene salvato.
            </p>
          </CollapsibleContent>
        </Collapsible>
        <div className="flex items-center justify-between gap-4">
          <span className="hidden text-xs text-muted-foreground sm:inline">Ctrl/⌘ + Invio per eseguire</span>
          <Button onClick={run} disabled={!canRun} className="ml-auto">
            <Play />
            {triggerRun.isPending ? "Avvio…" : "Esegui"}
          </Button>
        </div>

        {runs.data && runs.data.length > 0 && (
          <div className="space-y-2 border-t pt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Ultime run</h3>
              <Link href={`/runs?agentId=${agent.id}`} className="text-xs text-muted-foreground hover:underline">
                Vedi tutte ({runs.data.length})
              </Link>
            </div>
            <ul className="divide-y">
              {runs.data.slice(0, RECENT_RUNS).map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/runs/${item.id}`}
                    className="flex items-center gap-3 py-2 text-sm hover:bg-muted/50"
                  >
                    <RunStatusBadge status={item.status} />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.input || "—"}</span>
                    <span className="hidden whitespace-nowrap text-xs tabular-nums text-muted-foreground sm:inline">
                      {formatDuration(item.durationMs)}
                    </span>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatRelative(item.createdAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

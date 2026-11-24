import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type AgentActivity,
  getListAgentActivityQueryKey,
  useListAgentActivity,
} from "@workspace/api-client-react";
import { isRunQueryKey, livePollInterval, parseRunsEvent, queryKeysForRunChanges, runSummaryQueryKeys } from "@/lib/live-updates";

// Aggiornamenti in tempo reale delle run (issue #108): un solo EventSource su `/api/live` per tutta la console.
// Il flusso dice quale run è cambiata; qui si ricaricano le query interessate. EventSource è l'eccezione alla regola
// «solo hook di Orval»: un flusso SSE non è una richiesta con risposta, e i dati si rileggono comunque con gli hook.

const LiveContext = createContext<boolean>(false);

/** Vero finché il flusso è aperto: il polling delle run rallenta. */
export function useLiveConnected(): boolean {
  return useContext(LiveContext);
}

/** Intervallo di polling da usare: rapido senza flusso, lento con il flusso aperto. */
export function useLivePollInterval(fastMs: number | false): number | false {
  return livePollInterval(fastMs, useLiveConnected());
}

export function LiveUpdatesProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/live`);
    let everReady = false;
    const onReady = () => {
      // Dopo una riconnessione gli avvisi persi non tornano: si riallineano riepiloghi e run
      if (everReady) {
        for (const queryKey of runSummaryQueryKeys()) void queryClient.invalidateQueries({ queryKey });
        // Le singole run hanno chiavi `/api/runs/<id>`: il prefisso `/api/runs` non le copre
        void queryClient.invalidateQueries({ predicate: (q) => isRunQueryKey(q.queryKey) });
      }
      everReady = true;
      setConnected(true);
    };
    const onRuns = (event: MessageEvent<string>) => {
      for (const queryKey of queryKeysForRunChanges(parseRunsEvent(event.data))) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    // EventSource si riconnette da solo (retry del server); un 429 o un 403 lo chiudono: resta il polling
    const onError = () => setConnected(false);
    source.addEventListener("ready", onReady);
    source.addEventListener("runs", onRuns as EventListener);
    source.addEventListener("error", onError);
    return () => {
      source.close();
      setConnected(false);
    };
  }, [queryClient]);

  return <LiveContext.Provider value={connected}>{children}</LiveContext.Provider>;
}

/** Stato degli agenti non fermi, per id; con il flusso aperto si ricarica quando una run cambia. */
export function useAgentActivity(): { byAgent: Map<number, AgentActivity>; isLoading: boolean } {
  const interval = useLivePollInterval(10_000);
  const query = useListAgentActivity({ query: { queryKey: getListAgentActivityQueryKey(), refetchInterval: interval } });
  const data = query.data;
  const byAgent = useMemo(() => new Map((data ?? []).map((a) => [a.agentId, a])), [data]);
  return { byAgent, isLoading: query.isLoading };
}

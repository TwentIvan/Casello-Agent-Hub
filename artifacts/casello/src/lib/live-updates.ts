// Aggiornamenti in tempo reale delle run (issue #108): funzioni pure del flusso `/api/live` e dello stato per agente.
import {
  type AgentActivity,
  getGetDashboardStatsQueryKey,
  getGetFleetQueryKey,
  getGetRunQueryKey,
  getListAgentActivityQueryKey,
  getListRunMessagesQueryKey,
  getListRunStepsQueryKey,
  getListRunsQueryKey,
} from "@workspace/api-client-react";
import type { LedState } from "@/components/brand/led";

export type LiveRunChange = { runId: number; agentId: number | null };

/** Con il flusso aperto il polling resta solo come rete di sicurezza (altro container, avviso perso). */
export const LIVE_FALLBACK_MS = 30_000;

/** Intervallo di polling: quello rapido senza flusso, quello lento con il flusso aperto; `false` resta `false`. */
export function livePollInterval(fastMs: number | false, connected: boolean): number | false {
  if (fastMs === false) return false;
  return connected ? Math.max(fastMs, LIVE_FALLBACK_MS) : fastMs;
}

/** Legge i dati di un evento `runs`; scarta ciò che non ha la forma attesa (mai eccezioni). */
export function parseRunsEvent(data: string): LiveRunChange[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }
  const runs = (parsed as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) return [];
  const out: LiveRunChange[] = [];
  for (const item of runs.slice(0, 500)) {
    const runId = (item as { runId?: unknown })?.runId;
    const agentId = (item as { agentId?: unknown })?.agentId;
    if (!Number.isInteger(runId) || (runId as number) < 1) continue;
    out.push({ runId: runId as number, agentId: Number.isInteger(agentId) ? (agentId as number) : null });
  }
  return out;
}

/** Elenchi e riepiloghi toccati da ogni run: elenchi delle run, stato degli agenti, statistiche, flotta. */
export function runSummaryQueryKeys(): ReadonlyArray<readonly unknown[]> {
  return [getListRunsQueryKey(), getListAgentActivityQueryKey(), getGetDashboardStatsQueryKey(), getGetFleetQueryKey()];
}

/** Chiavi da ricaricare per le run cambiate: la run, i suoi passi e le sue istruzioni, poi elenchi e riepiloghi. */
export function queryKeysForRunChanges(changes: LiveRunChange[]): ReadonlyArray<readonly unknown[]> {
  if (changes.length === 0) return [];
  const keys: (readonly unknown[])[] = [];
  for (const { runId } of changes) {
    keys.push(getGetRunQueryKey(runId), getListRunStepsQueryKey(runId), getListRunMessagesQueryKey(runId));
  }
  return [...keys, ...runSummaryQueryKeys()];
}

const STATE_LABEL: Record<AgentActivity["state"], string> = {
  working: "In lavoro",
  waiting_user: "Aspetta te",
  idle: "Fermo",
};

/** LED, etichetta e dettaglio dello stato di un agente (assente dall'elenco = fermo). */
export function agentActivityView(activity: AgentActivity | undefined): { led: LedState; label: string; detail: string } {
  if (!activity || activity.state === "idle") return { led: "idle", label: STATE_LABEL.idle, detail: "Nessuna run in corso" };
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (activity.runningRuns) parts.push(plural(activity.runningRuns, "run in corso", "run in corso"));
  if (activity.pendingRuns) parts.push(plural(activity.pendingRuns, "run in coda", "run in coda"));
  if (activity.activeChildRuns) parts.push(plural(activity.activeChildRuns, "run figlia aperta", "run figlie aperte"));
  if (activity.awaitingClientRuns) parts.push(plural(activity.awaitingClientRuns, "run aspetta il client", "run aspettano il client"));
  if (activity.pendingActions) parts.push(plural(activity.pendingActions, "voce da confermare", "voci da confermare"));
  return {
    led: activity.state === "working" ? "work" : "ask",
    label: STATE_LABEL[activity.state],
    detail: parts.join(" · "),
  };
}

/** Chiave di una query sulle run (`/api/runs`, `/api/runs/<id>`, `/api/runs/<id>/steps`). */
export function isRunQueryKey(queryKey: readonly unknown[]): boolean {
  const head = queryKey[0];
  return typeof head === "string" && (head === "/api/runs" || head.startsWith("/api/runs/"));
}

// Attività in corso delle run (issue #118): cosa sta facendo ora una run che lavora (chiamata al modello, tool in
// esecuzione, anche più di uno insieme) e da quando. Registro in memoria, una voce per run per la durata della sua
// esecuzione: niente DB. Come gli avvisi di `events.ts` vale nel processo che esegue la run; con più container la
// console vede l'attività solo dal container che la esegue (altrimenti nessuna attività, i passi restano).
// Solo nomi dei tool, mai argomenti né risultati.

import type { LoopActivity } from "../agent-loop";

/** Al più tante voci in corso insieme (gruppi di chiamate in sola lettura): le altre non si mostrano. */
export const RUN_ACTIVITY_MAX_ITEMS = 20;

export type RunActivityItem = { kind: "model" | "tool"; toolName: string | null; since: string };

export type RunActivityView = { startedAt: string; items: RunActivityItem[] };

type Entry = { startedAt: string; items: Map<string, RunActivityItem> };

const entries = new Map<number, Entry>();

export function beginRunActivity(runId: number, now: Date = new Date()): void {
  entries.set(runId, { startedAt: now.toISOString(), items: new Map() });
}

export function endRunActivity(runId: number): void {
  entries.delete(runId);
}

/** Applica un avviso del ciclo dell'agente; senza voce (run non registrata o già finita) non fa nulla. */
export function applyRunActivity(runId: number, activity: LoopActivity, now: Date = new Date()): void {
  const entry = entries.get(runId);
  if (!entry) return;
  switch (activity.type) {
    case "model_start":
      entry.items.set("model", { kind: "model", toolName: null, since: now.toISOString() });
      return;
    case "model_end":
      entry.items.delete("model");
      return;
    case "tool_start":
      if (entry.items.size >= RUN_ACTIVITY_MAX_ITEMS) return;
      entry.items.set(`tool:${activity.callId}`, { kind: "tool", toolName: activity.toolName, since: now.toISOString() });
      return;
    case "tool_end":
      entry.items.delete(`tool:${activity.callId}`);
      return;
  }
}

/** Attività della run, null se non è in esecuzione in questo processo. */
export function readRunActivity(runId: number): RunActivityView | null {
  const entry = entries.get(runId);
  if (!entry) return null;
  return { startedAt: entry.startedAt, items: [...entry.items.values()].map((i) => ({ ...i })) };
}

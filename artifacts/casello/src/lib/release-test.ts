// Collaudo dei lavori: LED, frasi e piccoli calcoli per la console (logica pura).
import type { LedState } from "@/components/brand/led";

export interface ReleaseTestState {
  status: string;
  outcome: string | null;
  error?: string | null;
}

/** Il collaudo è ancora in movimento (si ricarica ogni 5 s). */
export function releaseTestOpen(status: string): boolean {
  return status === "queued" || status === "dispatching" || status === "running";
}

export function releaseTestLed(t: ReleaseTestState): LedState {
  switch (t.status) {
    case "queued":
    case "dispatching":
    case "running":
      return "work";
    case "done":
      return t.outcome === "ok" ? "ok" : t.outcome === "problems" || t.outcome === "not_startable" ? "ko" : "idle";
    case "failed":
      return "ko";
    default:
      return "idle";
  }
}

export function releaseTestLabel(t: ReleaseTestState): string {
  const why = t.error ? `: ${t.error}` : "";
  switch (t.status) {
    case "queued":
      return "Collaudo in coda";
    case "dispatching":
    case "running":
      return "Collaudo in corso";
    case "done":
      if (t.outcome === "ok") return "Collaudo superato";
      if (t.outcome === "problems") return "Problemi trovati";
      if (t.outcome === "not_startable") return "L'App non si avvia";
      return "Collaudo concluso";
    case "skipped":
      return `Collaudo saltato${why}`;
    case "failed":
      return `Collaudo non riuscito${why}`;
    case "cancelled":
      return "Collaudo annullato";
    default:
      return "Collaudo";
  }
}

/** Tempo residuo del link pubblico («23 min»); null se scaduto o la data non è valida. */
export function tunnelRemaining(until: string, now: Date): string | null {
  const end = Date.parse(until);
  if (Number.isNaN(end)) return null;
  const ms = end - now.getTime();
  if (ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? "meno di 1 min" : `${minutes} min`;
}

export const AUTO_FIX_MAX = 2;

export function autoFixCounter(n: number): string {
  return `correzioni automatiche ${n} di ${AUTO_FIX_MAX}`;
}

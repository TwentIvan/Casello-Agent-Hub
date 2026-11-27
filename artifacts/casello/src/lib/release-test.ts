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

/** Passo del collaudatore come arriva dal dettaglio del collaudo (campi usati qui). */
export interface ReleaseTestStepLike {
  type: string;
  toolName: string | null;
  args?: unknown;
}

const BROWSER_PHRASES: Record<string, string> = {
  open: "Apre una pagina nel browser",
  click: "Fa clic nella pagina",
  fill: "Compila un campo",
  press: "Preme un tasto",
  snapshot: "Legge la pagina",
  screenshot: "Fa uno screenshot",
  wait: "Aspetta la pagina",
};

/** Frase fissa di un passo del collaudatore (mai gli argomenti: possono contenere dati dell'App). */
export function releaseTestStepLine(step: ReleaseTestStepLike): string {
  if (step.type === "model") return "Ragiona";
  switch (step.toolName) {
    case "shell":
      return "Esegue un comando sul runner";
    case "browser": {
      const action = step.args && typeof step.args === "object" ? (step.args as { action?: unknown }).action : undefined;
      return (typeof action === "string" && BROWSER_PHRASES[action]) || "Usa il browser";
    }
    case "salva_ricetta":
      return "Salva la ricetta di avvio";
    case "consegna_collaudo":
      return "Consegna l'esito";
    default:
      return step.toolName ? `Usa ${step.toolName}` : "Lavora";
  }
}

/** Ultimi passi da mostrare mentre il collaudo è aperto (al più `max`, dal più vecchio al più recente). */
export function releaseTestProgress(steps: ReleaseTestStepLike[], max = 5): string[] {
  return steps.slice(-max).map(releaseTestStepLine);
}

/** Tempo trascorso da `startedAt` («45 s», «3 min 07 s»); null senza una data valida. */
export function releaseTestElapsed(startedAt: string | null, now: Date): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const total = Math.max(0, Math.floor((now.getTime() - start) / 1000));
  if (total < 60) return `${total} s`;
  return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, "0")} s`;
}

/** Stato del «Riaccendi» più recente, accanto al collaudo completo. */
export function relightLabel(r: { status: string; error: string | null }): string {
  switch (r.status) {
    case "queued":
      return "Riaccensione in coda";
    case "dispatching":
    case "running":
      return "Riaccensione in corso";
    case "done":
      return "Riaccensione conclusa";
    case "failed":
      return `Riaccensione non riuscita${r.error ? `: ${r.error}` : ""}`;
    case "cancelled":
      return "Riaccensione annullata";
    default:
      return r.error ? `Riaccensione saltata: ${r.error}` : "Riaccensione saltata";
  }
}

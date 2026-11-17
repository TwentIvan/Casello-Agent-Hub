import type { LedState } from "@/components/brand/led";
import type { TeamWorkStatus } from "@workspace/api-client-react";

// Lavoro su branch unico di una squadra e voce «Porta in produzione»: LED, frasi e lettura dei dati pubblici della voce.

const LEDS: Record<TeamWorkStatus, LedState> = {
  open: "work",
  awaiting_release: "ask",
  releasing: "work",
  released: "ok",
  abandoned: "idle",
};

const LABELS: Record<TeamWorkStatus, string> = {
  open: "in corso",
  awaiting_release: "in prova: da portare in produzione",
  releasing: "in attesa della CI della PR di rilascio",
  released: "in produzione",
  abandoned: "abbandonato",
};

export function workLed(status: TeamWorkStatus): LedState {
  return LEDS[status];
}

export function workStatusLabel(status: TeamWorkStatus): string {
  return LABELS[status];
}

/** Stato di una voce «Porta in produzione» approvata e non ancora conclusa. */
export function releaseStatusText(status: string): string | null {
  return status === "executing" ? LABELS.releasing : null;
}

export interface ReleaseTask {
  id: string;
  title: string;
  issue: number | null;
  prNumber: number | null;
  prUrl: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const https = (v: unknown): string | null => (typeof v === "string" && /^https:\/\//.test(v) ? v : null);

/** Dati pubblici della voce `release` (vedi `ensureReleaseItem` dell'API); i link non https si scartano. */
export function readReleaseArgs(args: unknown) {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const tasks = Array.isArray(a.tasks)
    ? a.tasks.flatMap((x): ReleaseTask[] => {
        const o = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
        if (!o || typeof o.id !== "string") return [];
        return [{ id: o.id, title: str(o.title) ?? o.id, issue: num(o.issue), prNumber: num(o.prNumber), prUrl: https(o.prUrl) }];
      })
    : [];
  return {
    number: num(a.number),
    repo: str(a.repo) ?? "",
    branch: str(a.branch) ?? "",
    baseBranch: str(a.baseBranch) ?? "",
    headSha: str(a.headSha),
    stagingBranch: str(a.stagingBranch),
    stagingUrl: https(a.stagingUrl),
    stagingNote: str(a.stagingNote),
    tasks,
    postScripts: Array.isArray(a.postScripts) ? a.postScripts.filter((p): p is string => typeof p === "string") : [],
  };
}

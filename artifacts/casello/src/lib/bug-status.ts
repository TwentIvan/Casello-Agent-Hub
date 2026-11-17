// Stati delle segnalazioni dei bug: frasi per l'utente (le stesse dell'API, lib/bugs/messages.ts), LED e contatore.
import type { EmbedBugStatus } from "@workspace/api-client-react";
import type { LedState } from "@/components/brand/led";

export const BUG_STATUS_LABELS: Record<EmbedBugStatus, string> = {
  received: "In esame",
  triage: "In esame",
  needs_info: "Serve una tua risposta",
  pending_approval: "In attesa di approvazione",
  in_progress: "In lavorazione",
  fixed: "Corretta",
  not_a_bug: "Non è un problema",
  duplicate: "Già segnalata",
  rejected: "Non accolta",
};

const LEDS: Record<EmbedBugStatus, LedState> = {
  received: "work",
  triage: "work",
  needs_info: "ask",
  pending_approval: "work",
  in_progress: "work",
  fixed: "ok",
  not_a_bug: "idle",
  duplicate: "idle",
  rejected: "idle",
};

export function bugStatusLed(status: EmbedBugStatus): LedState {
  return LEDS[status];
}

/** Contatore del pulsante per il visitatore: le segnalazioni con novità non ancora viste. */
export function visitorBadge(list: readonly { unseen: boolean }[]): number {
  return list.filter((b) => b.unseen).length;
}

export type BugArgs = {
  title: string;
  description: string;
  steps: string;
  expected: string;
  triage: { verdict: string; summary: string; question: string } | null;
  team: { id: number; name: string; status: string | null } | null;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Contenuto di una voce `bug` (args = { title, description, steps, expected, triage, team }). */
export function readBugArgs(args: unknown): BugArgs {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const t = a.triage && typeof a.triage === "object" ? (a.triage as Record<string, unknown>) : null;
  const team = a.team && typeof a.team === "object" ? (a.team as Record<string, unknown>) : null;
  return {
    title: str(a.title),
    description: str(a.description),
    steps: str(a.steps),
    expected: str(a.expected),
    triage: t ? { verdict: str(t.verdict), summary: str(t.summary), question: str(t.question) } : null,
    team: team && typeof team.id === "number" ? { id: team.id, name: str(team.name), status: typeof team.status === "string" ? team.status : null } : null,
  };
}

const NO_TEAM = "nessuna squadra per i bug attiva per questa App";

/**
 * Motivo per cui «Approva e affida alla squadra» è disattivato, o null. La voce porta id e nome della squadra al momento
 * dell'accodamento, non il suo stato: se lo stato non è noto decide il server (409 col motivo) all'approvazione.
 */
export function bugApprovalBlocker(args: { team?: { status?: string | null } | null }): string | null {
  const team = args.team;
  if (!team) return NO_TEAM;
  return team.status == null || team.status === "active" ? null : NO_TEAM;
}

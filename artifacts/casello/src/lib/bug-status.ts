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

import type { EvolutionCycleView, EvolutionFrequency, EvolutionRoundViewStatus } from "@workspace/api-client-react";
import type { LedState } from "@/components/brand/led";

/** Il pulsante «Attiva» si abilita con la casella e lo slug scritto (trim, senza maiuscole). */
export function canActivate(input: { accepted: boolean; typedSlug: string; appSlug: string }): boolean {
  if (!input.accepted) return false;
  const typed = input.typedSlug.trim().toLowerCase();
  return typed !== "" && typed === input.appSlug.trim().toLowerCase();
}

const ROUND_LED: Record<EvolutionRoundViewStatus, LedState> = {
  analyzing: "work",
  approving: "work",
  implementing: "work",
  awaiting_release: "ask",
  done: "ok",
  failed: "ko",
  blocked: "ko",
  stopped: "idle",
  rejected: "idle",
};

export function roundStatusLed(status: EvolutionRoundViewStatus): LedState {
  return ROUND_LED[status];
}

export const ROUND_STATUS_LABELS: Record<EvolutionRoundViewStatus, string> = {
  analyzing: "Analisi",
  approving: "Scelta delle voci",
  implementing: "Implementazione",
  awaiting_release: "In attesa del rilascio",
  done: "Concluso",
  failed: "Non riuscito",
  blocked: "Bloccato",
  rejected: "Rifiutato",
  stopped: "Fermato",
};

export const FREQUENCY_LABELS: Record<EvolutionFrequency, string> = {
  daily: "Ogni giorno",
  every_3_days: "Ogni 3 giorni",
  weekly: "Ogni settimana",
  monthly: "Ogni mese",
};

export const USER_PAUSE_REASON = "fermato dall'utente";
export const MAX_ITEMS_PER_ROUND = 10;
export const MAX_MONTHLY_BUDGET_USD = 10000;

type Settings = { analysisAiModelId: number | null; teamTemplateId: number | null; itemsPerRound: number; monthlyBudgetUsd: number };

/**
 * Il consenso va rinnovato se non c'è un ciclo o un consenso valido, se salva chi non ha attivato il ciclo (con il consenso
 * diventa lui a pagare), o se cambiano modello, modello di squadra e voci o sale il tetto; frequenza e tetto più basso no.
 */
export function needsConsent(saved: (Settings & { consentValid: boolean; isPayer: boolean }) | null, next: Settings): boolean {
  if (!saved || !saved.consentValid || !saved.isPayer) return true;
  return (
    saved.analysisAiModelId !== next.analysisAiModelId ||
    saved.teamTemplateId !== next.teamTemplateId ||
    saved.itemsPerRound !== next.itemsPerRound ||
    next.monthlyBudgetUsd > saved.monthlyBudgetUsd
  );
}

/**
 * LED del ciclo: «Porta in produzione» da decidere `ask`, giro aperto `work` (con il ciclo attivo), attivo `ok`, pausa
 * dell'utente `idle`, altre pause `ko`.
 */
export function cycleLed(view: Pick<EvolutionCycleView, "status" | "pausedReason" | "openRound">): LedState {
  if (view.openRound?.status === "awaiting_release") return "ask";
  if (view.openRound && view.status === "active") return "work";
  if (view.status === "active") return "ok";
  return view.pausedReason && view.pausedReason !== USER_PAUSE_REASON ? "ko" : "idle";
}

export function budgetError(value: string): string | null {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n <= 0 || n > MAX_MONTHLY_BUDGET_USD)
    return `Il tetto va da più di 0 a ${MAX_MONTHLY_BUDGET_USD.toLocaleString("it-IT")} USD.`;
  return null;
}

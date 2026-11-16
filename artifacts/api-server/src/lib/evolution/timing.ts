import type { evolutionFrequencyEnum } from "@workspace/db";

export type EvolutionFrequency = (typeof evolutionFrequencyEnum.enumValues)[number];

const DAY_MS = 86_400_000;

export const FREQUENCY_MS: Record<EvolutionFrequency, number> = {
  daily: DAY_MS,
  every_3_days: 3 * DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
};

export function nextRoundAt(startedAt: Date, f: EvolutionFrequency): Date {
  return new Date(startedAt.getTime() + FREQUENCY_MS[f]);
}

/** Attesa dopo errori di fila: 30 minuti, raddoppia a ogni errore, al più 24 ore. */
export function backoffMs(errors: number): number {
  return Math.min(1_800_000 * 2 ** Math.max(0, errors), DAY_MS);
}

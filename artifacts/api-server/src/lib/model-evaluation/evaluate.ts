// Valutazione del modello di un agente (issue #112): dalle ultime run (esito, token, costo, errori dei tool) e dai prezzi
// dei modelli dell'utente con strumenti, i modelli più economici a parità di successo e la stima del risparmio.
// Funzioni pure: le letture dal DB stanno in `service.ts`.

/** Finestra delle run considerate (giorni) e run al più lette, dalle più recenti. */
export const EVALUATION_WINDOW_DAYS = 30;
export const EVALUATION_MAX_RUNS = 50;
/** Sotto questo numero di run concluse (non annullate) la valutazione dice che i dati sono pochi. */
export const EVALUATION_MIN_RUNS = 5;
/** Suggerimenti al più. */
export const EVALUATION_MAX_SUGGESTIONS = 5;
/** Run osservate con un modello perché il suo tasso di successo conti nel confronto. */
export const EVALUATION_MIN_OBSERVED = 3;
/** Un candidato con un successo osservato più basso di questo margine rispetto al modello attuale si scarta. */
export const EVALUATION_SUCCESS_MARGIN = 0.1;

export const EVALUATION_MESSAGES = {
  agentNotFound: "Agente non trovato",
  noModel: "l'agente non ha un modello: sceglilo prima di valutarlo",
  noRuns: "nessuna run conclusa negli ultimi 30 giorni: valutazione non possibile",
  fewRuns: "poche run concluse negli ultimi 30 giorni: la stima è indicativa",
  currentUnpriced: "prezzo del modello attuale non noto: risparmio non calcolabile",
  noCheaper: "nessun modello con strumenti più economico tra i tuoi account",
  cheaper: "modelli con strumenti più economici a parità di successo osservato",
} as const;

export type EvaluationRun = {
  status: "succeeded" | "failed" | "cancelled";
  aiModelId: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number;
  costUsd: number | null;
  toolCalls: number;
  toolErrors: number;
};

export type EvaluationModel = {
  id: number;
  name: string;
  accountName: string;
  priceInput: number | null;
  priceOutput: number | null;
  priceCachedInput: number | null;
  /** Selezionabile (disponibile, non solo audio), con strumenti certi, non in anteprima, non di un account nodo. */
  eligible: boolean;
};

export type TokenProfile = { prompt: number; cached: number; completion: number };

export type ModelUsage = {
  aiModelId: number | null;
  name: string | null;
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  avgCostUsd: number | null;
  toolCalls: number;
  toolErrors: number;
};

export type Suggestion = {
  aiModelId: number;
  name: string;
  accountName: string;
  priceInput: number;
  priceOutput: number;
  estimatedCostPerRunUsd: number;
  savingPerRunUsd: number;
  savingPercent: number;
  estimatedMonthlySavingUsd: number;
  observedRuns: number;
  observedSuccessRate: number | null;
};

export type Evaluation = {
  windowDays: number;
  enoughData: boolean;
  currentModel: {
    aiModelId: number;
    name: string;
    accountName: string;
    priceInput: number | null;
    priceOutput: number | null;
    estimatedCostPerRunUsd: number | null;
  } | null;
  usage: {
    runs: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    successRate: number | null;
    avgPromptTokens: number | null;
    avgCachedTokens: number | null;
    avgCompletionTokens: number | null;
    avgCostUsd: number | null;
    unpricedRuns: number;
    toolCalls: number;
    toolErrors: number;
    runsInWindow: number;
  };
  byModel: ModelUsage[];
  suggestions: Suggestion[];
  note: string;
};

const round = (n: number, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Costo stimato di una run con un profilo di token; null senza prezzi di ingresso e uscita. */
export function estimateRunCost(
  profile: TokenProfile,
  prices: { priceInput: number | null; priceOutput: number | null; priceCachedInput: number | null },
): number | null {
  if (prices.priceInput === null || prices.priceOutput === null) return null;
  const cached = Math.min(profile.cached, profile.prompt);
  // Senza prezzo della cache i token letti dalla cache costano come gli altri (stima prudente)
  const cachedPrice = prices.priceCachedInput ?? prices.priceInput;
  return round(((profile.prompt - cached) * prices.priceInput + cached * cachedPrice + profile.completion * prices.priceOutput) / 1_000_000);
}

/** Successo sulle run concluse e non annullate; null senza run. */
function successRate(succeeded: number, failed: number): number | null {
  const n = succeeded + failed;
  return n === 0 ? null : round(succeeded / n, 4);
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Valutazione: profilo medio dei token delle run (tutte, con qualunque modello: il lavoro è dell'agente), costo stimato
 * del modello attuale e dei candidati con quel profilo, candidati più economici non peggiori nel successo osservato.
 */
export function evaluateModel(input: {
  currentModelId: number | null;
  runs: EvaluationRun[];
  runsInWindow: number;
  models: EvaluationModel[];
}): Evaluation {
  const { runs, models } = input;
  const modelById = new Map(models.map((m) => [m.id, m]));
  const succeeded = runs.filter((r) => r.status === "succeeded").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const cancelled = runs.filter((r) => r.status === "cancelled").length;
  const withTokens = runs.filter((r) => r.promptTokens !== null || r.completionTokens !== null);
  const avgPrompt = average(withTokens.map((r) => r.promptTokens ?? 0));
  const avgCached = average(withTokens.map((r) => r.cachedTokens));
  const avgCompletion = average(withTokens.map((r) => r.completionTokens ?? 0));
  const priced = runs.filter((r) => r.costUsd !== null).map((r) => r.costUsd!);
  const avgCost = average(priced);
  const profile: TokenProfile | null =
    avgPrompt === null ? null : { prompt: avgPrompt, cached: avgCached ?? 0, completion: avgCompletion ?? 0 };

  // Uso per modello, in ordine di run
  const groups = new Map<number | null, EvaluationRun[]>();
  for (const r of runs) {
    const g = groups.get(r.aiModelId);
    if (g) g.push(r);
    else groups.set(r.aiModelId, [r]);
  }
  const byModel: ModelUsage[] = [...groups.entries()]
    .map(([aiModelId, rs]) => {
      const ok = rs.filter((r) => r.status === "succeeded").length;
      const ko = rs.filter((r) => r.status === "failed").length;
      const costs = rs.filter((r) => r.costUsd !== null).map((r) => r.costUsd!);
      const avg = average(costs);
      return {
        aiModelId,
        name: aiModelId === null ? null : (modelById.get(aiModelId)?.name ?? null),
        runs: rs.length,
        succeeded: ok,
        failed: ko,
        successRate: successRate(ok, ko),
        avgCostUsd: avg === null ? null : round(avg),
        toolCalls: rs.reduce((a, r) => a + r.toolCalls, 0),
        toolErrors: rs.reduce((a, r) => a + r.toolErrors, 0),
      };
    })
    .sort((a, b) => b.runs - a.runs || (a.aiModelId ?? 0) - (b.aiModelId ?? 0));
  const usageOf = (id: number) => byModel.find((u) => u.aiModelId === id);

  const current = input.currentModelId === null ? undefined : modelById.get(input.currentModelId);
  const currentEstimate = current && profile ? estimateRunCost(profile, current) : null;
  const enoughData = succeeded + failed >= EVALUATION_MIN_RUNS;

  const usage = {
    runs: runs.length,
    succeeded,
    failed,
    cancelled,
    successRate: successRate(succeeded, failed),
    avgPromptTokens: avgPrompt === null ? null : Math.round(avgPrompt),
    avgCachedTokens: avgCached === null ? null : Math.round(avgCached),
    avgCompletionTokens: avgCompletion === null ? null : Math.round(avgCompletion),
    avgCostUsd: avgCost === null ? null : round(avgCost),
    unpricedRuns: runs.length - priced.length,
    toolCalls: runs.reduce((a, r) => a + r.toolCalls, 0),
    toolErrors: runs.reduce((a, r) => a + r.toolErrors, 0),
    runsInWindow: input.runsInWindow,
  };
  const currentModel = current
    ? {
        aiModelId: current.id,
        name: current.name,
        accountName: current.accountName,
        priceInput: current.priceInput,
        priceOutput: current.priceOutput,
        estimatedCostPerRunUsd: currentEstimate,
      }
    : null;

  const base = { windowDays: EVALUATION_WINDOW_DAYS, enoughData, currentModel, usage, byModel };
  if (input.currentModelId === null) return { ...base, suggestions: [], note: EVALUATION_MESSAGES.noModel };
  if (succeeded + failed === 0 || profile === null) return { ...base, suggestions: [], note: EVALUATION_MESSAGES.noRuns };
  if (currentEstimate === null) return { ...base, suggestions: [], note: EVALUATION_MESSAGES.currentUnpriced };

  // Successo di riferimento: quello osservato col modello attuale se basta, altrimenti quello di tutte le run
  const currentUsage = usageOf(input.currentModelId);
  const reference =
    currentUsage && currentUsage.succeeded + currentUsage.failed >= EVALUATION_MIN_OBSERVED ? currentUsage.successRate : usage.successRate;

  const suggestions: Suggestion[] = [];
  for (const m of models) {
    if (!m.eligible || m.id === input.currentModelId || m.priceInput === null || m.priceOutput === null) continue;
    const estimate = estimateRunCost(profile, m)!;
    const saving = currentEstimate - estimate;
    if (saving <= 0) continue;
    const observed = usageOf(m.id);
    const observedRuns = observed ? observed.succeeded + observed.failed : 0;
    const observedRate = observed && observedRuns > 0 ? observed.successRate : null;
    // A parità di successo: un modello già provato con l'agente e andato peggio non si propone
    if (observedRate !== null && observedRuns >= EVALUATION_MIN_OBSERVED && reference !== null && observedRate < reference - EVALUATION_SUCCESS_MARGIN)
      continue;
    suggestions.push({
      aiModelId: m.id,
      name: m.name,
      accountName: m.accountName,
      priceInput: m.priceInput,
      priceOutput: m.priceOutput,
      estimatedCostPerRunUsd: estimate,
      savingPerRunUsd: round(saving),
      savingPercent: Math.round((saving / currentEstimate) * 100),
      estimatedMonthlySavingUsd: round(saving * input.runsInWindow, 2),
      observedRuns,
      observedSuccessRate: observedRate,
    });
  }
  // Prima i modelli già provati con successo dall'agente, poi i più economici
  suggestions.sort(
    (a, b) =>
      Number(b.observedRuns >= EVALUATION_MIN_OBSERVED) - Number(a.observedRuns >= EVALUATION_MIN_OBSERVED) ||
      a.estimatedCostPerRunUsd - b.estimatedCostPerRunUsd ||
      a.aiModelId - b.aiModelId,
  );
  const top = suggestions.slice(0, EVALUATION_MAX_SUGGESTIONS);
  const note =
    top.length === 0 ? EVALUATION_MESSAGES.noCheaper : enoughData ? EVALUATION_MESSAGES.cheaper : EVALUATION_MESSAGES.fewRuns;
  return { ...base, suggestions: top, note };
}

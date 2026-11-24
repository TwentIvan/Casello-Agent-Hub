import { describe, expect, it } from "vitest";
import { EVALUATION_MESSAGES, estimateRunCost, evaluateModel, type EvaluationModel, type EvaluationRun } from "./evaluate";

const run = (over: Partial<EvaluationRun> = {}): EvaluationRun => ({
  status: "succeeded",
  aiModelId: 1,
  promptTokens: 10_000,
  completionTokens: 1_000,
  cachedTokens: 0,
  costUsd: 0.012,
  toolCalls: 2,
  toolErrors: 0,
  ...over,
});

const model = (id: number, priceInput: number | null, priceOutput: number | null, over: Partial<EvaluationModel> = {}): EvaluationModel => ({
  id,
  name: `m${id}`,
  accountName: "Account",
  priceInput,
  priceOutput,
  priceCachedInput: null,
  eligible: true,
  ...over,
});

describe("estimateRunCost", () => {
  it("prezzi per milione di token, cache al suo prezzo o a quello pieno", () => {
    expect(estimateRunCost({ prompt: 10_000, cached: 0, completion: 1_000 }, { priceInput: 1, priceOutput: 2, priceCachedInput: null })).toBe(0.012);
    expect(estimateRunCost({ prompt: 10_000, cached: 5_000, completion: 0 }, { priceInput: 1, priceOutput: 2, priceCachedInput: 0.1 })).toBe(0.0055);
    expect(estimateRunCost({ prompt: 10_000, cached: 5_000, completion: 0 }, { priceInput: 1, priceOutput: 2, priceCachedInput: null })).toBe(0.01);
    expect(estimateRunCost({ prompt: 1, cached: 0, completion: 1 }, { priceInput: null, priceOutput: 2, priceCachedInput: null })).toBeNull();
  });
});

describe("evaluateModel", () => {
  it("propone i modelli con strumenti più economici con la stima del risparmio", () => {
    const runs = [...Array(6)].map(() => run());
    const ev = evaluateModel({
      currentModelId: 1,
      runs,
      runsInWindow: 40,
      models: [model(1, 1, 2), model(2, 0.1, 0.2), model(3, 0.5, 1), model(4, 5, 10), model(5, 0.01, 0.01, { eligible: false })],
    });
    expect(ev.enoughData).toBe(true);
    expect(ev.currentModel?.estimatedCostPerRunUsd).toBe(0.012);
    expect(ev.usage).toMatchObject({ runs: 6, succeeded: 6, successRate: 1, avgPromptTokens: 10_000, toolCalls: 12, toolErrors: 0 });
    expect(ev.suggestions.map((s) => s.aiModelId)).toEqual([2, 3]);
    expect(ev.suggestions[0]).toMatchObject({
      estimatedCostPerRunUsd: 0.0012,
      savingPerRunUsd: 0.0108,
      savingPercent: 90,
      estimatedMonthlySavingUsd: 0.43,
      observedRuns: 0,
      observedSuccessRate: null,
    });
    expect(ev.note).toBe(EVALUATION_MESSAGES.cheaper);
  });

  it("non propone un modello già provato dall'agente con meno successo; prima quelli provati con successo", () => {
    const runs = [
      ...[...Array(4)].map(() => run()),
      ...[...Array(3)].map(() => run({ aiModelId: 2, status: "failed", costUsd: 0.001, toolErrors: 1 })),
      ...[...Array(3)].map(() => run({ aiModelId: 3, costUsd: 0.006 })),
    ];
    const ev = evaluateModel({ currentModelId: 1, runs, runsInWindow: 10, models: [model(1, 1, 2), model(2, 0.1, 0.2), model(3, 0.5, 1), model(4, 0.2, 0.4)] });
    expect(ev.suggestions.map((s) => s.aiModelId)).toEqual([3, 4]);
    expect(ev.suggestions[0]).toMatchObject({ observedRuns: 3, observedSuccessRate: 1 });
    const m2 = ev.byModel.find((m) => m.aiModelId === 2)!;
    expect(m2).toMatchObject({ runs: 3, failed: 3, successRate: 0, toolErrors: 3 });
  });

  it("dice perché non c'è una stima: senza modello, senza run, senza prezzo, nessun modello più economico", () => {
    const models = [model(1, 1, 2), model(2, null, null)];
    expect(evaluateModel({ currentModelId: null, runs: [run()], runsInWindow: 1, models }).note).toBe(EVALUATION_MESSAGES.noModel);
    expect(evaluateModel({ currentModelId: 1, runs: [run({ status: "cancelled" })], runsInWindow: 1, models }).note).toBe(
      EVALUATION_MESSAGES.noRuns,
    );
    expect(evaluateModel({ currentModelId: 2, runs: [run()], runsInWindow: 1, models }).note).toBe(EVALUATION_MESSAGES.currentUnpriced);
    expect(evaluateModel({ currentModelId: 1, runs: [run()], runsInWindow: 1, models }).note).toBe(EVALUATION_MESSAGES.noCheaper);
    const few = evaluateModel({ currentModelId: 1, runs: [run()], runsInWindow: 1, models: [...models, model(3, 0.1, 0.1)] });
    expect(few.enoughData).toBe(false);
    expect(few.note).toBe(EVALUATION_MESSAGES.fewRuns);
  });
});

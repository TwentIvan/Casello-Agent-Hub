import { describe, expect, it } from "vitest";
import { abortAnalysis, registerAnalysisAbort, releaseAnalysisAbort } from "./abort";

describe("annullamento delle analisi", () => {
  it("abortAnalysis interrompe il segnale dell'analisi registrata in questo processo", () => {
    const signal = registerAnalysisAbort(9001);
    expect(signal.aborted).toBe(false);
    expect(abortAnalysis(9001)).toBe(true);
    expect(signal.aborted).toBe(true);
    releaseAnalysisAbort(9001);
  });

  it("analisi non registrata o già rilasciata: false", () => {
    expect(abortAnalysis(9002)).toBe(false);
    registerAnalysisAbort(9003);
    releaseAnalysisAbort(9003);
    expect(abortAnalysis(9003)).toBe(false);
  });
});

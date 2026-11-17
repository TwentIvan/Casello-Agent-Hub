import { describe, it, expect } from "vitest";
import { consentHash, consentRequired, consentText, CONSENT_VERSION, type ConsentSettings } from "./consent";

const base: ConsentSettings = {
  mergeMode: "staging",
  stagingBranch: "staging",
  teamTemplateId: 4,
  analysisAiModelId: 7,
  itemsPerRound: 3,
  monthlyBudgetUsd: 50,
};

describe("consenso", () => {
  it("l'impronta è stabile e cambia con ogni campo", () => {
    expect(CONSENT_VERSION).toBe("2026-11-16");
    expect(consentHash(base)).toBe(consentHash({ ...base }));
    expect(consentHash(base)).toMatch(/^[0-9a-f]{64}$/);
    const variants: ConsentSettings[] = [
      { ...base, mergeMode: "direct" },
      { ...base, stagingBranch: "x" },
      { ...base, teamTemplateId: null },
      { ...base, analysisAiModelId: 8 },
      { ...base, itemsPerRound: 4 },
      { ...base, monthlyBudgetUsd: 80 },
    ];
    for (const v of variants) expect(consentHash(v)).not.toBe(consentHash(base));
  });

  it("il rinnovo serve per ogni campo e per un tetto più alto, non per uno più basso", () => {
    expect(consentRequired(null, base)).toBe(true);
    expect(consentRequired(base, { ...base })).toBe(false);
    expect(consentRequired(base, { ...base, analysisAiModelId: 8 })).toBe(true);
    expect(consentRequired(base, { ...base, itemsPerRound: 5 })).toBe(true);
    expect(consentRequired(base, { ...base, mergeMode: "direct" })).toBe(true);
    expect(consentRequired(base, { ...base, stagingBranch: "x" })).toBe(true);
    expect(consentRequired(base, { ...base, teamTemplateId: 9 })).toBe(true);
    expect(consentRequired(base, { ...base, monthlyBudgetUsd: 80 })).toBe(true);
    expect(consentRequired({ ...base, monthlyBudgetUsd: 80 }, base)).toBe(false);
  });

  it("il testo in modalità direct cita il branch base e il deploy in produzione", () => {
    const text = consentText({ ...base, mergeMode: "direct", appName: "Mister", baseBranch: "main" }).join("\n");
    expect(text).toContain("main");
    expect(text).toContain("deploy in produzione");
    expect(text).toContain("a tuo rischio");
    expect(text).toContain("50");
    expect(text).not.toContain("!");
    expect(text).not.toContain("Casello");
  });

  it("senza squadra le righe su squadra e merge mancano", () => {
    const text = consentText({ ...base, teamTemplateId: null, mergeMode: "direct", appName: "Mister", baseBranch: "main" }).join("\n");
    expect(text).not.toContain("deploy in produzione");
    expect(text).not.toContain("PLAN");
  });
});

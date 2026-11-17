import { describe, it, expect } from "vitest";
import type { EvolutionCycle } from "@workspace/db";
import { consentHash, consentRequired, consentText, consentValid, CONSENT_VERSION, type ConsentSettings } from "./consent";

const base: ConsentSettings = {
  teamTemplateId: 4,
  analysisAiModelId: 7,
  itemsPerRound: 3,
  monthlyBudgetUsd: 50,
};

describe("consenso", () => {
  it("l'impronta è stabile e cambia con ogni campo", () => {
    expect(CONSENT_VERSION).toBe("2026-11-17");
    expect(consentHash(base)).toBe(consentHash({ ...base }));
    expect(consentHash(base)).toMatch(/^[0-9a-f]{64}$/);
    const variants: ConsentSettings[] = [
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
    expect(consentRequired(base, { ...base, teamTemplateId: 9 })).toBe(true);
    expect(consentRequired(base, { ...base, monthlyBudgetUsd: 80 })).toBe(true);
    expect(consentRequired({ ...base, monthlyBudgetUsd: 80 }, base)).toBe(false);
  });

  it("con il modello di squadra il testo elenca squadra, PLAN, merge sul lavoro, branch di prova e lascia all'utente la produzione", () => {
    const text = consentText({ ...base, appName: "Mister", baseBranch: "main" }).join("\n");
    expect(text).toContain("squadra");
    expect(text).toContain("PLAN");
    expect(text).toContain("branch del lavoro");
    expect(text).toContain("branch di prova");
    expect(text).toContain("Porta in produzione");
    expect(text).toContain("main");
    expect(text).toContain("a tuo rischio");
    expect(text).toContain("50");
    expect(text).not.toContain("!");
    expect(text).not.toContain("Casello");
  });

  it("senza squadra le righe su squadra e merge mancano", () => {
    const text = consentText({ ...base, teamTemplateId: null, appName: "Mister", baseBranch: "main" }).join("\n");
    expect(text).not.toContain("PLAN");
    expect(text).not.toContain("branch del lavoro");
    expect(text).toContain("Implementa");
  });

  it("consenso valido solo con la versione attuale e l'impronta delle impostazioni salvate", () => {
    const cycle = {
      teamTemplateId: 4,
      analysisAiModelId: 7,
      itemsPerRound: 3,
      monthlyBudgetUsd: "50.00",
      consentAt: new Date(),
      activatedBy: 1,
      consentVersion: CONSENT_VERSION,
      consentHash: consentHash(base),
    } as unknown as EvolutionCycle;
    expect(consentValid(cycle)).toBe(true);
    expect(consentValid({ ...cycle, consentVersion: "2026-11-16" })).toBe(false);
    expect(consentValid({ ...cycle, itemsPerRound: 4 })).toBe(false);
    expect(consentValid({ ...cycle, analysisAiModelId: null })).toBe(false);
    expect(consentValid({ ...cycle, activatedBy: null })).toBe(false);
  });
});

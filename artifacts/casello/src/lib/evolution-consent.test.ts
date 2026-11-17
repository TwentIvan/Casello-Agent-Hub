import { describe, expect, it } from "vitest";
import { budgetError, canActivate, cycleLed, needsConsent, roundStatusLed } from "./evolution-consent";

const base = { accepted: true, typedSlug: "the-hub-up", appSlug: "the-hub-up" };

describe("canActivate", () => {
  it("serve la casella e lo slug scritto", () => {
    expect(canActivate(base)).toBe(true);
    expect(canActivate({ ...base, accepted: false })).toBe(false);
    expect(canActivate({ ...base, typedSlug: "" })).toBe(false);
    expect(canActivate({ ...base, typedSlug: "altra-app" })).toBe(false);
  });

  it("confronta lo slug dopo trim e senza distinguere le maiuscole", () => {
    expect(canActivate({ ...base, typedSlug: "  The-Hub-Up " })).toBe(true);
  });
});

describe("roundStatusLed", () => {
  it("associa ogni stato del giro a un LED", () => {
    expect(roundStatusLed("analyzing")).toBe("work");
    expect(roundStatusLed("approving")).toBe("work");
    expect(roundStatusLed("implementing")).toBe("work");
    expect(roundStatusLed("awaiting_release")).toBe("ask");
    expect(roundStatusLed("done")).toBe("ok");
    expect(roundStatusLed("failed")).toBe("ko");
    expect(roundStatusLed("blocked")).toBe("ko");
    expect(roundStatusLed("stopped")).toBe("idle");
    expect(roundStatusLed("rejected")).toBe("idle");
  });
});

describe("needsConsent", () => {
  const saved = { analysisAiModelId: 1, teamTemplateId: 2, itemsPerRound: 3, monthlyBudgetUsd: 10, consentValid: true, isPayer: true };
  const same = { analysisAiModelId: 1, teamTemplateId: 2, itemsPerRound: 3, monthlyBudgetUsd: 10 };
  it("senza ciclo o con consenso non valido serve", () => {
    expect(needsConsent(null, same)).toBe(true);
    expect(needsConsent({ ...saved, consentValid: false }, same)).toBe(true);
  });
  it("serve sempre se salva chi non ha attivato il ciclo, anche senza cambiare nulla", () => {
    expect(needsConsent({ ...saved, isPayer: false }, same)).toBe(true);
    expect(needsConsent({ ...saved, isPayer: false }, { ...same, monthlyBudgetUsd: 5 })).toBe(true);
  });
  it("serve se cambiano modello o voci o sale il tetto", () => {
    expect(needsConsent(saved, { ...same, analysisAiModelId: 2 })).toBe(true);
    expect(needsConsent(saved, { ...same, itemsPerRound: 4 })).toBe(true);
    expect(needsConsent(saved, { ...same, teamTemplateId: null })).toBe(true);
    expect(needsConsent(saved, { ...same, monthlyBudgetUsd: 11 })).toBe(true);
  });
  it("non serve se il tetto scende o non cambia nulla", () => {
    expect(needsConsent(saved, { ...same, monthlyBudgetUsd: 5 })).toBe(false);
    expect(needsConsent(saved, same)).toBe(false);
  });
});

describe("cycleLed", () => {
  it("distingue pausa dell'utente e pausa per errore", () => {
    expect(cycleLed({ status: "paused", pausedReason: "fermato dall'utente", openRound: null })).toBe("idle");
    expect(cycleLed({ status: "paused", pausedReason: "tetto di spesa raggiunto", openRound: null })).toBe("ko");
    expect(cycleLed({ status: "active", pausedReason: null, openRound: null })).toBe("ok");
  });

  it("con la squadra: Porta in produzione da decidere `ask`, giro in corso `work`, giro fermo con il ciclo in pausa come la pausa", () => {
    const round = (status: "implementing" | "awaiting_release") =>
      ({ id: 1, number: 1, status, analysisId: null, itemIds: [], outcome: null, startedAt: "", finishedAt: null, teamInstanceId: 3, workId: null, releaseActionNumber: null, rejectionNote: null }) as const;
    expect(cycleLed({ status: "active", pausedReason: null, openRound: round("awaiting_release") })).toBe("ask");
    expect(cycleLed({ status: "paused", pausedReason: "fermato dall'utente", openRound: round("awaiting_release") })).toBe("ask");
    expect(cycleLed({ status: "active", pausedReason: null, openRound: round("implementing") })).toBe("work");
    expect(cycleLed({ status: "paused", pausedReason: "fermato dall'utente", openRound: round("implementing") })).toBe("idle");
  });
});

describe("budgetError", () => {
  it("accetta tra 0 escluso e 10 000", () => {
    expect(budgetError("10")).toBeNull();
    expect(budgetError("10000")).toBeNull();
    expect(budgetError("0")).not.toBeNull();
    expect(budgetError("10001")).not.toBeNull();
    expect(budgetError("")).not.toBeNull();
  });
});

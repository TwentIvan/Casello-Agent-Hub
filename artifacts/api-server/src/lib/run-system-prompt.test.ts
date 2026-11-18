import { describe, expect, it } from "vitest";
import type { Agent, App } from "@workspace/db";
import { buildSystemPrompt } from "./run-executor";

// Il prompt di sistema delle run porta la data di oggi in ora italiana: senza, il modello la indovina
// (nella prova reale il Responsabile ha scritto «oggi, 8 novembre» il 9 novembre).

const agent = { name: "Responsabile di prodotto", systemPrompt: "Istruzioni" } as Agent;
const app = { name: "Botcave", baseUrl: "https://example.test/", description: null, functionalDescription: null } as App;

describe("buildSystemPrompt", () => {
  it("riporta giorno, data e ora in ora italiana", () => {
    const text = buildSystemPrompt(agent, app, new Date("2026-11-09T15:12:06Z"));
    expect(text).toContain("Oggi è lunedì 9 novembre 2026, ore 16:12 (ora italiana).");
  });

  it("dopo la mezzanotte italiana è già il giorno dopo", () => {
    const text = buildSystemPrompt(agent, app, new Date("2026-11-09T23:30:00Z"));
    expect(text).toContain("Oggi è martedì 10 novembre 2026, ore 00:30 (ora italiana).");
  });
});

describe("buildSystemPrompt: nome del bot", () => {
  const named = { ...app, slug: "hub", leadName: "Bea" } as App;
  it("il Responsabile (general) sa come si chiama in questa app", () => {
    const lead = { name: "Responsabile di prodotto", systemPrompt: "Istruzioni", role: "general" } as Agent;
    expect(buildSystemPrompt(lead, named)).toContain("In questa app ti chiami Bea.");
  });
  it("il nome predefinito non si ripete; per casello c'è Barbara", () => {
    const lead = { name: "Responsabile di prodotto", systemPrompt: "Istruzioni", role: "general" } as Agent;
    expect(buildSystemPrompt(lead, { ...app, slug: "hub", leadName: null } as App)).not.toContain("ti chiami");
    expect(buildSystemPrompt(lead, { ...app, slug: "casello", leadName: null } as App)).toContain("In questa app ti chiami Barbara.");
  });
  it("un agente di area non riceve la riga", () => {
    const area = { name: "Area", systemPrompt: "Istruzioni", role: "area" } as Agent;
    expect(buildSystemPrompt(area, named)).not.toContain("ti chiami");
  });
});

describe("runLimitsFor", () => {
  it("il Responsabile (general) ha limiti più ampi, gli agenti di area quelli di sempre", async () => {
    const { runLimitsFor, PRODUCT_LEAD_LIMITS } = await import("./run-executor");
    expect(runLimitsFor({ role: "general" })).toEqual({ maxRounds: 12, maxActiveMs: 180_000, maxTokens: 200_000 });
    expect(PRODUCT_LEAD_LIMITS.maxTokens).toBe(200_000);
    expect(runLimitsFor({ role: "area" })).toEqual({});
  });
});

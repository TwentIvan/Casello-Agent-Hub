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

import { describe, expect, it } from "vitest";
import type { AgentModelDeprecation } from "@workspace/api-client-react";
import { agentDeprecationLine, deprecationLabel, replacementText } from "./agent-deprecations";

const item: AgentModelDeprecation = {
  agentId: 1,
  agentName: "Smistatore",
  appId: 2,
  appName: "The Hub Up",
  aiModelId: 3,
  modelName: "Vecchio",
  deprecationDate: "2026-12-05",
  retired: false,
  replacement: { aiModelId: 4, name: "Nuovo", accountName: "DeepSeek", priceInput: 0.28, priceOutput: 0.42 },
};

describe("agent-deprecations", () => {
  it("etichetta: in dismissione con la data, ritirato con o senza data", () => {
    expect(deprecationLabel(item)).toBe("In dismissione il 05/12/2026");
    expect(deprecationLabel({ retired: true, deprecationDate: null })).toBe("Ritirato");
    expect(deprecationLabel({ retired: true, deprecationDate: "2026-11-01" })).toBe("Ritirato il 01/11/2026");
  });
  it("sostituto proposto o assente", () => {
    expect(replacementText(item)).toBe("sostituto proposto: Nuovo (DeepSeek, 0,28 / 0,42 $ per Mtok)");
    expect(replacementText({ replacement: null })).toBe("nessun sostituto con strumenti tra i tuoi modelli");
  });
  it("riga del riepilogo", () => {
    expect(agentDeprecationLine(item)).toBe(
      "Smistatore (The Hub Up) · Vecchio: in dismissione il 05/12/2026, sostituto proposto: Nuovo (DeepSeek, 0,28 / 0,42 $ per Mtok)",
    );
  });
});

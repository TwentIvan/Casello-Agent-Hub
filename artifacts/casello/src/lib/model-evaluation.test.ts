import { describe, expect, it } from "vitest";
import { evidenceLabel, formatRate, toolErrorsLabel } from "./model-evaluation";

describe("valutazione del modello", () => {
  it("tasso di successo in percentuale", () => {
    expect(formatRate(0.8333)).toBe("83 %");
    expect(formatRate(1)).toBe("100 %");
    expect(formatRate(null)).toBe("n.d.");
  });

  it("evidenza dei suggerimenti", () => {
    expect(evidenceLabel(0, null)).toBe("mai provato con questo agente: confronto sui prezzi");
    expect(evidenceLabel(1, 1)).toBe("provato in 1 run, successo 100 %");
    expect(evidenceLabel(4, 0.75)).toBe("provato in 4 run, successo 75 %");
  });

  it("errori dei tool", () => {
    expect(toolErrorsLabel(0, 0)).toBe("nessuna chiamata");
    expect(toolErrorsLabel(40, 2)).toBe("2 su 40");
  });
});

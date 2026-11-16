import { describe, it, expect } from "vitest";
import { EVOLUTION_MESSAGES, roundOutcome } from "./messages";

describe("messaggi del ciclo", () => {
  it("l'esito del giro conta le voci", () => {
    expect(roundOutcome(3)).toBe("3 voci approvate: usa Implementa per farle realizzare");
    expect(roundOutcome(1)).toBe("1 voce approvata: usa Implementa per farla realizzare");
    expect(EVOLUTION_MESSAGES.notFound).toBe("ciclo non trovato");
  });
});

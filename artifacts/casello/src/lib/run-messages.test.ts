import { describe, expect, it } from "vitest";
import { canInstruct, instructionError, runMessageView } from "./run-messages";

describe("istruzioni a una run in corso", () => {
  it("solo una run in esecuzione riceve istruzioni", () => {
    expect(canInstruct("running")).toBe(true);
    for (const s of ["pending", "awaiting_client", "succeeded", "failed", "cancelled"] as const) {
      expect(canInstruct(s)).toBe(false);
    }
  });

  it("testo vuoto o troppo lungo non si manda", () => {
    expect(instructionError("  ")).toBe("Scrivi l'istruzione");
    expect(instructionError("x".repeat(2_001))).toBe("Al massimo 2000 caratteri");
    expect(instructionError(" usa l'altro tool ")).toBeNull();
  });

  it("LED per stato", () => {
    expect(runMessageView("pending").led).toBe("work");
    expect(runMessageView("delivered").led).toBe("ok");
    expect(runMessageView("dropped").led).toBe("idle");
  });
});

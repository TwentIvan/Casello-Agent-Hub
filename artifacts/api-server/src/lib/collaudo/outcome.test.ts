import { describe, expect, it } from "vitest";
import { autoFixDecision, toDbOutcome } from "./outcome";

describe("autoFixDecision", () => {
  const base = { outcome: "problems" as const, autoFix: true, autoRejects: 0, itemPending: true };

  it("rifiuta la voce con esito negativo, correzione automatica attiva e meno di 2 rifiuti", () => {
    expect(autoFixDecision(base)).toBe("reject");
    expect(autoFixDecision({ ...base, outcome: "not_startable" })).toBe("reject");
  });

  it("esaurisce le correzioni dopo 2 rifiuti automatici", () => {
    expect(autoFixDecision({ ...base, autoRejects: 2 })).toBe("keep_exhausted");
    expect(autoFixDecision({ ...base, outcome: "not_startable", autoRejects: 3 })).toBe("keep_exhausted");
  });

  it("tiene la voce con esito ok", () => {
    expect(autoFixDecision({ ...base, outcome: "ok" })).toBe("keep");
  });

  it("tiene la voce se non è più pending", () => {
    expect(autoFixDecision({ ...base, itemPending: false })).toBe("keep");
  });

  it("tiene la voce se la correzione automatica è spenta", () => {
    expect(autoFixDecision({ ...base, autoFix: false })).toBe("keep");
    expect(autoFixDecision({ ...base, autoFix: false, autoRejects: 2 })).toBe("keep");
  });
});

describe("toDbOutcome", () => {
  it("traduce gli esiti nei valori del database", () => {
    expect(toDbOutcome("ok")).toBe("ok");
    expect(toDbOutcome("problemi")).toBe("problems");
    expect(toDbOutcome("non_avviabile")).toBe("not_startable");
  });
});

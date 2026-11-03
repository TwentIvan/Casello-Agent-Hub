import { describe, expect, it } from "vitest";
import { declaredLevelFromMcp, effectiveLevel, isValidOverride } from "./levels";

describe("effectiveLevel", () => {
  it("senza deroga vale il livello dichiarato", () => {
    expect(effectiveLevel({ level: "L1", levelOverride: null })).toBe("L1");
  });
  it("con deroga vale il più alto", () => {
    expect(effectiveLevel({ level: "L1", levelOverride: "L3" })).toBe("L3");
    expect(effectiveLevel({ level: "L2", levelOverride: "L0" })).toBe("L2");
  });
});

describe("isValidOverride", () => {
  it("ammette null e livelli non inferiori", () => {
    expect(isValidOverride("L2", null)).toBe(true);
    expect(isValidOverride("L2", "L2")).toBe(true);
    expect(isValidOverride("L2", "L3")).toBe(true);
  });
  it("rifiuta un livello inferiore", () => {
    expect(isValidOverride("L2", "L1")).toBe(false);
  });
});

describe("declaredLevelFromMcp", () => {
  it("legge casello/level dai metadati", () => {
    expect(declaredLevelFromMcp({ _meta: { "casello/level": "L3" } })).toBe("L3");
  });
  it("ripiega su readOnlyHint se il livello non è valido", () => {
    expect(declaredLevelFromMcp({ _meta: { "casello/level": "L9" }, annotations: { readOnlyHint: true } })).toBe("L0");
  });
  it("senza metadati vale L2", () => {
    expect(declaredLevelFromMcp({})).toBe("L2");
    expect(declaredLevelFromMcp({ _meta: "x" })).toBe("L2");
  });
});

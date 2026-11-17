import { describe, expect, it } from "vitest";
import { INSTRUCTIONS_MAX_CHARS, instructionsCounter } from "./instructions-text";

describe("instructionsCounter", () => {
  it("conta dopo trimEnd", () => {
    expect(instructionsCounter("abc  \n")).toEqual({ length: 3, over: false });
  });
  it("il limite è 8 000 compresi", () => {
    expect(instructionsCounter("a".repeat(INSTRUCTIONS_MAX_CHARS)).over).toBe(false);
    expect(instructionsCounter("a".repeat(8001))).toEqual({ length: 8001, over: true });
  });
});

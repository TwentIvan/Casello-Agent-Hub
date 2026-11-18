import { describe, expect, it } from "vitest";
import { botNameError, resolveBotNames } from "./bot-names";

describe("resolveBotNames", () => {
  it("usa i predefiniti", () => {
    expect(resolveBotNames({ slug: "x", alfredName: null, luciusName: null, leadName: null })).toEqual({
      alfred: "Alfred",
      lucius: "Lucius",
      lead: "Responsabile",
    });
  });
  it("per casello il Responsabile è Barbara", () => {
    expect(resolveBotNames({ slug: "casello", alfredName: null, luciusName: null, leadName: null }).lead).toBe("Barbara");
  });
  it("i nomi scelti vincono", () => {
    expect(resolveBotNames({ slug: "casello", alfredName: "Al", luciusName: "Lu", leadName: "Bea" })).toEqual({
      alfred: "Al",
      lucius: "Lu",
      lead: "Bea",
    });
  });
});

describe("botNameError", () => {
  it("accetta nomi validi e null", () => {
    expect(botNameError("Bea")).toBeNull();
    expect(botNameError(null)).toBeNull();
  });
  it.each(["", " ", "a\nb", "<b>", "x".repeat(41)])("rifiuta %j", (v) => {
    expect(botNameError(v)).toBe("nome del bot non valido");
  });
});

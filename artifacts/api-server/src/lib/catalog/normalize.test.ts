import { describe, expect, it } from "vitest";
import { familyAndVersion, normalizeModelId } from "./normalize";

describe("normalizeModelId", () => {
  it("toglie models/ e porta in minuscolo", () => {
    expect(normalizeModelId("models/Gemini-2.5-Flash")).toBe("gemini-2.5-flash");
  });
});

describe("familyAndVersion", () => {
  it("usa il nome senza prefisso provider e senza la famiglia", () => {
    expect(familyAndVersion("gemini-3.5-flash", "Google: Gemini 3.5 Flash")).toEqual({ family: "Gemini", version: "3.5 Flash" });
    expect(familyAndVersion("mistral-small", "Mistral: Mistral Small")).toEqual({ family: "Mistral", version: "Small" });
  });
  it("senza nome ricava la versione dall'id", () => {
    expect(familyAndVersion("deepseek-v4-pro", null)).toEqual({ family: "DeepSeek", version: "v4 pro" });
    expect(familyAndVersion("deepseek/deepseek-chat", null)).toEqual({ family: "DeepSeek", version: "chat" });
    expect(familyAndVersion("codestral-2501", null)).toEqual({ family: "Mistral", version: "2501" });
  });
  it("niente trattino iniziale nella versione; versione vuota → id leggibile", () => {
    expect(familyAndVersion("gpt-4o", "OpenAI: GPT-4o")).toEqual({ family: "GPT", version: "4o" });
    expect(familyAndVersion("o1", "OpenAI: o1")).toEqual({ family: "O1", version: "o1" });
    expect(familyAndVersion("o1", null)).toEqual({ family: "O1", version: "o1" });
    expect(familyAndVersion("gemini", "Gemini")).toEqual({ family: "Gemini", version: "gemini" });
  });
  it("famiglia sconosciuta: primo token con l'iniziale maiuscola", () => {
    expect(familyAndVersion("foobar-7b-instruct", null)).toEqual({ family: "Foobar", version: "7b instruct" });
  });
});

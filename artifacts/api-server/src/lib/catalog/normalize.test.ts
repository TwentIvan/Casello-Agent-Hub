import { describe, expect, it } from "vitest";
import { catalogKeysFor, familyAndVersion, normalizeModelId } from "./normalize";
import type { SourceEntry } from "./sources";

function entry(over: Partial<SourceEntry>): SourceEntry {
  return {
    source: "openrouter", key: "x", litellmProvider: null, name: null, releasedAt: null,
    priceInput: null, priceOutput: null, contextTokens: null, supportsTools: null, deprecationDate: null, mode: "chat",
    supportsVision: null, supportsReasoning: null, ...over,
  };
}

describe("normalizeModelId", () => {
  it("toglie models/ e porta in minuscolo", () => {
    expect(normalizeModelId("models/Gemini-2.5-Flash")).toBe("gemini-2.5-flash");
  });
});

describe("catalogKeysFor", () => {
  it("OpenRouter: chiave openrouter e chiave del provider", () => {
    expect(catalogKeysFor(entry({ key: "google/gemini-3.5-flash" }))).toEqual([
      { provider: "openrouter", modelId: "google/gemini-3.5-flash" },
      { provider: "gemini", modelId: "gemini-3.5-flash" },
    ]);
    expect(catalogKeysFor(entry({ key: "deepseek/deepseek-chat" }))).toEqual([
      { provider: "openrouter", modelId: "deepseek/deepseek-chat" },
      { provider: "deepseek", modelId: "deepseek-chat" },
    ]);
    expect(catalogKeysFor(entry({ key: "mistralai/mistral-small" })).map((k) => k.provider)).toEqual(["openrouter", "mistral"]);
  });
  it("OpenRouter: le varianti con ':' restano solo su openrouter", () => {
    expect(catalogKeysFor(entry({ key: "google/gemini-2.0-flash-exp:free" }))).toEqual([
      { provider: "openrouter", modelId: "google/gemini-2.0-flash-exp:free" },
    ]);
  });
  it("OpenRouter: altri prefissi solo openrouter", () => {
    expect(catalogKeysFor(entry({ key: "meta-llama/llama-3" })).map((k) => k.provider)).toEqual(["openrouter"]);
  });
  it("LiteLLM: mappa i provider e toglie il prefisso", () => {
    expect(catalogKeysFor(entry({ source: "litellm", key: "together_ai/x", litellmProvider: "together_ai" }))).toEqual([
      { provider: "together", modelId: "x" },
    ]);
    expect(catalogKeysFor(entry({ source: "litellm", key: "gemini/gemini-2.5-flash", litellmProvider: "gemini" }))).toEqual([
      { provider: "gemini", modelId: "gemini-2.5-flash" },
    ]);
    expect(catalogKeysFor(entry({ source: "litellm", key: "openrouter/deepseek/deepseek-chat", litellmProvider: "openrouter" }))).toEqual([
      { provider: "openrouter", modelId: "deepseek/deepseek-chat" },
    ]);
  });
  it("LiteLLM: provider non gestiti o assenti non danno chiavi", () => {
    expect(catalogKeysFor(entry({ source: "litellm", key: "bedrock/foo", litellmProvider: "bedrock" }))).toEqual([]);
    expect(catalogKeysFor(entry({ source: "litellm", key: "foo", litellmProvider: null }))).toEqual([]);
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
  it("famiglia sconosciuta: primo token con l'iniziale maiuscola", () => {
    expect(familyAndVersion("foobar-7b-instruct", null)).toEqual({ family: "Foobar", version: "7b instruct" });
  });
});

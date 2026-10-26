import { describe, expect, it } from "vitest";
import { PROVIDER_REGISTRY } from "./provider-registry-data";
import { authorFor, canonicalModelKey, directProviderFor, providerModelId, providerSlugFor } from "./canonical";
import type { SourceEntry } from "./sources";

function entry(over: Partial<SourceEntry>): SourceEntry {
  return {
    source: "litellm", key: "x", litellmProvider: null, name: null, releasedAt: null, priceInput: null,
    priceOutput: null, contextTokens: null, supportsTools: null, deprecationDate: null, mode: "chat",
    supportsVision: null, supportsReasoning: null, ...over,
  };
}

describe("canonicalModelKey", () => {
  it("Bedrock, Anthropic e Vertex dello stesso Claude hanno la stessa chiave", () => {
    const k = canonicalModelKey("claude-sonnet-4-5-20250929");
    expect(canonicalModelKey("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(k);
    expect(canonicalModelKey("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(k);
    expect(canonicalModelKey("claude-sonnet-4-5@20250929")).toBe(k);
    // OpenRouter, dopo il prefisso d'autore
    expect(canonicalModelKey("anthropic/claude-sonnet-4.5")).toBe(k);
    expect(k).toBe("claude-sonnet-4-5");
  });
  it("toglie regione e autore, suffissi di versione", () => {
    expect(canonicalModelKey("us.meta.llama3-3-70b-instruct-v1:0")).toBe("llama3-3-70b-instruct");
    expect(canonicalModelKey("claude-3-5-sonnet@20240620")).toBe("claude-3-5-sonnet");
    expect(canonicalModelKey("eu.amazon.nova-pro-v1:0")).toBe("nova-pro");
    expect(canonicalModelKey("jp.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("claude-sonnet-4-5");
  });
  it("code generiche: si tiene anche il segmento precedente", () => {
    const a = canonicalModelKey("flux-pro/v1.1");
    expect(a).toBe("flux-pro/v1-1");
    expect(canonicalModelKey("fal-ai/flux-pro/v1.1")).toBe(a);
    expect(canonicalModelKey("flux/dev")).toBe("flux/dev");
    expect(canonicalModelKey("fal-ai/flux/dev")).toBe("flux/dev");
    expect(canonicalModelKey("flux/dev")).not.toBe(canonicalModelKey("flux-pro/v1.1"));
    expect(canonicalModelKey("a/b/pro/latest")).toBe("b/pro/latest");
    expect(canonicalModelKey("mistralai/mistral-small")).toBe("mistral-small");
  });
  it("prefissi regione e autore aggiuntivi", () => {
    expect(canonicalModelKey("au.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("claude-sonnet-4-5");
    expect(canonicalModelKey("us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("claude-sonnet-4-5");
    expect(canonicalModelKey("cohere.command-r-v1:0")).toBe("command-r");
    expect(canonicalModelKey("ai21.jamba-1-5-large-v1:0")).toBe("jamba-1-5-large");
    expect(canonicalModelKey("deepseek.r1-v1:0")).toBe("r1");
    expect(canonicalModelKey("qwen.qwen3-32b-v1:0")).toBe("qwen3-32b");
  });
  it("usa l'ultimo segmento, minuscolo, _ e . → -; le varianti restano", () => {
    expect(canonicalModelKey("meta-llama/Llama_3.3-70B")).toBe("llama-3-3-70b");
    expect(canonicalModelKey("gemini-2.5-flash")).toBe("gemini-2-5-flash");
    expect(canonicalModelKey("deepseek/deepseek-chat:free")).toBe("deepseek-chat:free");
  });
});

describe("canonicalModelKey: date in coda", () => {
  it("toglie i suffissi Vertex @default e @latest", () => {
    expect(canonicalModelKey("claude-haiku-5-5@default")).toBe("claude-haiku-5-5");
    expect(canonicalModelKey("claude-haiku-5-5@latest")).toBe("claude-haiku-5-5");
    expect(canonicalModelKey("claude-haiku-5-5@20250514")).toBe("claude-haiku-5-5");
  });
  it("toglie la data in coda se resta qualcosa prima", () => {
    expect(canonicalModelKey("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(canonicalModelKey("openai/gpt-4o")).toBe("gpt-4o");
    expect(canonicalModelKey("o3-mini-20250131")).toBe("o3-mini");
    expect(canonicalModelKey("20250131")).toBe("20250131");
    expect(canonicalModelKey("gemini-2.0-flash-exp:free")).toBe("gemini-2-0-flash-exp:free");
  });
});

describe("providerSlugFor", () => {
  it("il registro vince sulla normalizzazione", () => {
    expect(providerSlugFor(entry({ litellmProvider: "bedrock_converse" }), PROVIDER_REGISTRY)).toEqual({ slug: "bedrock", known: true });
    expect(providerSlugFor(entry({ litellmProvider: "together_ai" }), PROVIDER_REGISTRY)).toEqual({ slug: "together", known: true });
  });
  it("nome sconosciuto → slug normalizzato, known false", () => {
    expect(providerSlugFor(entry({ litellmProvider: "nuovo_provider" }), PROVIDER_REGISTRY)).toEqual({ slug: "nuovo-provider", known: false });
    expect(providerSlugFor(entry({ litellmProvider: "  --Å Ü/Ex!! " }), PROVIDER_REGISTRY).slug).toMatch(/^[a-z0-9_-]{1,64}$/);
    expect(providerSlugFor(entry({ litellmProvider: "!!!" }), PROVIDER_REGISTRY)).toEqual({ slug: "sconosciuto", known: false });
    expect(providerSlugFor(entry({ litellmProvider: null }), PROVIDER_REGISTRY)).toEqual({ slug: "sconosciuto", known: false });
    expect(providerSlugFor(entry({ litellmProvider: "a".repeat(100) }), PROVIDER_REGISTRY).slug).toHaveLength(64);
  });
  it("slug scoperto uguale a uno del registro → suffisso -litellm (mai attaccato a un provider del registro)", () => {
    expect(providerSlugFor(entry({ litellmProvider: "Custom" }), PROVIDER_REGISTRY)).toEqual({ slug: "custom-litellm", known: false });
    expect(providerSlugFor(entry({ litellmProvider: "Anthropic" }), PROVIDER_REGISTRY)).toEqual({ slug: "anthropic-litellm", known: false });
    expect(providerSlugFor(entry({ litellmProvider: "open router" }), PROVIDER_REGISTRY)).toEqual({ slug: "open-router", known: false });
  });
  it("OpenRouter → openrouter", () => {
    expect(providerSlugFor(entry({ source: "openrouter", key: "google/gemini-2.5-flash" }), PROVIDER_REGISTRY)).toEqual({ slug: "openrouter", known: true });
  });
});

describe("directProviderFor", () => {
  it("autore OpenRouter → provider del registro; varianti e litellm → null", () => {
    expect(directProviderFor(entry({ source: "openrouter", key: "google/gemini-2.5-flash" }), PROVIDER_REGISTRY)).toBe("gemini");
    expect(directProviderFor(entry({ source: "openrouter", key: "google/gemini-2.0-flash-exp:free" }), PROVIDER_REGISTRY)).toBeNull();
    expect(directProviderFor(entry({ source: "openrouter", key: "nessuno/modello" }), PROVIDER_REGISTRY)).toBeNull();
    expect(directProviderFor(entry({ source: "litellm", key: "gemini/x", litellmProvider: "gemini" }), PROVIDER_REGISTRY)).toBeNull();
  });
});

describe("providerModelId", () => {
  it("toglie il prefisso del provider LiteLLM e normalizza", () => {
    expect(providerModelId(entry({ key: "gemini/models/Gemini-2.5-Flash", litellmProvider: "gemini" }))).toBe("gemini-2.5-flash");
    expect(providerModelId(entry({ key: "claude-3-5-sonnet-20240620", litellmProvider: "anthropic" }))).toBe("claude-3-5-sonnet-20240620");
    expect(providerModelId(entry({ source: "openrouter", key: "Google/Gemini-2.5-Flash" }))).toBe("google/gemini-2.5-flash");
  });
});

describe("authorFor", () => {
  it("dal prefisso OpenRouter, poi dalla famiglia", () => {
    expect(authorFor("claude-sonnet-4-5", null)).toBe("Anthropic");
    expect(authorFor("x", "meta-llama")).toBe("Meta");
    expect(authorFor("x", "nuovoautore")).toBe("Nuovoautore");
    expect(authorFor("gpt-5", null)).toBe("OpenAI");
    expect(authorFor("o3-mini", null)).toBe("OpenAI");
    expect(authorFor("llama3-3-70b", null)).toBe("Meta");
    expect(authorFor("codestral-2501", null)).toBe("Mistral");
    expect(authorFor("zzz", null)).toBe("Sconosciuto");
  });
});

import { describe, expect, it } from "vitest";
import { fakeSourcesFetch } from "../../../test/fake-sources";
import { mergeCatalog } from "./merge";
import { fetchLiteLlmSource, fetchOpenRouterSource } from "./sources";
import type { SourceEntry } from "./sources";

const NOW = new Date("2026-10-26T00:00:00Z");

async function fixtureEntries(): Promise<SourceEntry[]> {
  const f = fakeSourcesFetch();
  return [...(await fetchOpenRouterSource(f)), ...(await fetchLiteLlmSource(f))];
}

describe("mergeCatalog", () => {
  it("per i provider diretti i prezzi vengono da LiteLLM, il rilascio da OpenRouter", async () => {
    const recs = await mergeCatalog(await fixtureEntries(), NOW);
    const r = recs.find((x) => x.provider === "deepseek" && x.modelId === "deepseek-v4-pro")!;
    expect(r.priceInput).toBeCloseTo(1.45);
    expect(r.priceOutput).toBeCloseTo(2.9);
    expect(r.contextTokens).toBe(1000000);
    expect(r.releasedAt).toEqual(new Date(1767225600 * 1000));
    expect(r.family).toBe("DeepSeek");
    expect(r.version).toBe("V4 Pro");
    expect(r.sources).toMatchObject({ price: "litellm", contextTokens: "litellm", supportsTools: "litellm", releasedAt: "openrouter" });
    expect(r.sources.deprecationDate).toBeUndefined();
  });
  it("per openrouter i prezzi vengono da OpenRouter", async () => {
    const recs = await mergeCatalog(await fixtureEntries(), NOW);
    const r = recs.find((x) => x.provider === "openrouter" && x.modelId === "deepseek/deepseek-chat")!;
    expect(r.priceInput).toBeCloseTo(0.27);
    expect(r.priceOutput).toBeCloseTo(1.1);
    expect(r.sources.price).toBe("openrouter");
    const v4 = recs.find((x) => x.provider === "openrouter" && x.modelId === "deepseek/deepseek-v4-pro")!;
    expect(v4.priceInput).toBeCloseTo(1.74);
  });
  it("la data di dismissione passata rende il modello retired, futura deprecated", async () => {
    const entries = await fixtureEntries();
    const old = mergeCatalog(entries, NOW).find((x) => x.provider === "gemini" && x.modelId === "gemini-2.5-flash")!;
    expect(old.status).toBe("retired");
    expect(old.sources.deprecationDate).toBe("litellm");
    expect(old.releasedAt).not.toBeNull();
    const early = mergeCatalog(entries, new Date("2026-01-01T00:00:00Z")).find((x) => x.modelId === "gemini-2.5-flash" && x.provider === "gemini")!;
    expect(early.status).toBe("deprecated");
    const fresh = mergeCatalog(entries, NOW).find((x) => x.provider === "gemini" && x.modelId === "gemini-3.5-flash")!;
    expect(fresh.status).toBe("available");
    expect(fresh.deprecationDate).toBeNull();
  });
  it("le chiavi ripetute nella stessa fonte: vince la prima", async () => {
    const [first] = await fetchLiteLlmSource(fakeSourcesFetch());
    const dup = { ...first!, priceInput: 99, priceOutput: 99 };
    const recs = mergeCatalog([first!, dup], NOW);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.priceInput).toBe(first!.priceInput);
  });
  it("la coppia di prezzi viene dalla prima fonte che li ha entrambi", () => {
    const base = { name: null, releasedAt: null, contextTokens: null, supportsTools: null, deprecationDate: null, mode: "chat" as const, supportsVision: null, supportsReasoning: null };
    const recs = mergeCatalog(
      [
        { ...base, source: "litellm", key: "gemini/m", litellmProvider: "gemini", priceInput: 1, priceOutput: null },
        { ...base, source: "openrouter", key: "google/m", litellmProvider: null, priceInput: 2, priceOutput: 3 },
      ],
      NOW,
    );
    const r = recs.find((x) => x.provider === "gemini")!;
    expect([r.priceInput, r.priceOutput]).toEqual([2, 3]);
    expect(r.sources.price).toBe("openrouter");
  });
});

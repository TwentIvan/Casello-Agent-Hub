import { describe, expect, it } from "vitest";
import { fakeSourcesFetch } from "../../../test/fake-sources";
import { PROVIDER_REGISTRY } from "./provider-registry-data";
import { keepFailedOfferFields, mergeUniversal, type OfferRecord } from "./merge";
import { fetchLiteLlmSource, fetchOpenRouterSource } from "./sources";
import type { SourceEntry } from "./sources";

const NOW = new Date("2026-10-26T00:00:00Z");

async function fixtureEntries(): Promise<SourceEntry[]> {
  const f = fakeSourcesFetch();
  return [...(await fetchOpenRouterSource(f)), ...(await fetchLiteLlmSource(f))];
}

const BASE = { name: null, releasedAt: null, contextTokens: null, supportsTools: null, deprecationDate: null, mode: "chat" as const, supportsVision: null, supportsReasoning: null };

describe("mergeUniversal", () => {
  async function merged(now = NOW) {
    return mergeUniversal(await fixtureEntries(), PROVIDER_REGISTRY, now);
  }

  it("lo stesso Claude su Bedrock e su Anthropic: un modello, due offerte", async () => {
    const { models, offers } = await merged();
    const key = "claude-sonnet-4-5";
    const ms = models.filter((m) => m.canonicalKey === key);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ author: "Anthropic", family: "Claude", mode: "chat", supportsTools: true, supportsVision: true, supportsReasoning: true, releasedAt: null });
    const os = offers.filter((o) => o.canonicalKey === key);
    expect(os.map((o) => [o.provider, o.providerModelId]).sort()).toEqual([
      ["anthropic", "claude-sonnet-4-5-20250929"],
      ["bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0"],
    ]);
    expect(os.every((o) => o.priceInput === 3 && o.priceOutput === 15 && o.sources.price === "litellm")).toBe(true);
  });

  it("provider sconosciuto: offerta con lo slug normalizzato e voce in discovered col conteggio", async () => {
    const { offers, discovered } = await merged();
    expect(discovered).toEqual([{ slug: "nuovo-provider", name: "nuovo_provider", count: 1 }]);
    expect(offers.find((o) => o.provider === "nuovo-provider")).toMatchObject({ providerModelId: "modello-x", canonicalKey: "modello-x" });
  });

  it("i modelli non chat entrano con il loro tipo", async () => {
    const { models, offers } = await merged();
    expect(models.find((m) => m.canonicalKey === "text-embedding-3-small")).toMatchObject({ mode: "embedding" });
    expect(offers.find((o) => o.providerModelId === "text-embedding-3-small")).toMatchObject({ provider: "openai", priceOutput: null });
  });

  it("precedenze: diretti da LiteLLM con riserva OpenRouter, openrouter da OpenRouter", async () => {
    const { models, offers } = await merged();
    const direct = offers.find((o) => o.provider === "deepseek" && o.providerModelId === "deepseek-v4-pro")!;
    expect(direct.priceInput).toBeCloseTo(1.45);
    expect(direct.contextTokens).toBe(1000000);
    expect(direct.sources).toMatchObject({ price: "litellm", contextTokens: "litellm", supportsTools: "litellm" });
    const or = offers.find((o) => o.provider === "openrouter" && o.providerModelId === "deepseek/deepseek-v4-pro")!;
    expect(or.priceInput).toBeCloseTo(1.74);
    expect(or.sources.price).toBe("openrouter");
    expect(direct.canonicalKey).toBe("deepseek-v4-pro");
    expect(or.canonicalKey).toBe("deepseek-v4-pro");
    // Nome e rilascio del modello da OpenRouter
    const m = models.find((x) => x.canonicalKey === "deepseek-v4-pro")!;
    expect(m).toMatchObject({ author: "DeepSeek", family: "DeepSeek", version: "V4 Pro", releasedAt: new Date(1767225600 * 1000) });
    // Senza voce LiteLLM, OpenRouter non crea l'offerta diretta: il modello esiste solo su openrouter
    expect(offers.find((o) => o.provider === "deepseek" && o.providerModelId === "deepseek-chat")).toBeUndefined();
    expect(offers.filter((o) => o.canonicalKey === "deepseek-chat").map((o) => o.provider)).toEqual(["openrouter"]);
    expect(models.find((x) => x.canonicalKey === "deepseek-chat")).toBeDefined();
    // Le varianti (`:free`) solo su openrouter
    expect(offers.filter((o) => o.providerModelId.includes(":free")).map((o) => o.provider)).toEqual(["openrouter"]);
  });

  it("dismissione solo da LiteLLM: passata retired, futura deprecated", async () => {
    const find = (os: OfferRecord[]) => os.find((o) => o.provider === "gemini" && o.providerModelId === "gemini-2.5-flash")!;
    const old = find((await merged()).offers);
    expect(old.status).toBe("retired");
    expect(old.sources.deprecationDate).toBe("litellm");
    expect(find((await merged(new Date("2026-01-01T00:00:00Z"))).offers).status).toBe("deprecated");
    const viaOr = (await merged()).offers.find((o) => o.provider === "openrouter" && o.providerModelId === "google/gemini-2.5-flash")!;
    expect(viaOr.status).toBe("available");
  });

  it("un id di OpenRouter non crea un'offerta diretta, ma si abbina al modello di LiteLLM", () => {
    const { models, offers } = mergeUniversal(
      [
        { ...BASE, source: "openrouter", key: "anthropic/claude-sonnet-4.5", litellmProvider: null, name: "Anthropic: Claude Sonnet 4.5", priceInput: 3, priceOutput: 15, releasedAt: new Date("2025-09-29") },
        { ...BASE, source: "litellm", key: "claude-sonnet-4-5-20250929", litellmProvider: "anthropic", priceInput: 3, priceOutput: 15 },
      ],
      PROVIDER_REGISTRY,
      NOW,
    );
    expect(offers.map((o) => [o.provider, o.providerModelId])).toEqual([
      ["openrouter", "anthropic/claude-sonnet-4.5"],
      ["anthropic", "claude-sonnet-4-5-20250929"],
    ]);
    expect(offers.find((o) => o.provider === "anthropic")!.sources.price).toBe("litellm");
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ canonicalKey: "claude-sonnet-4-5", author: "Anthropic", version: "Sonnet 4.5", releasedAt: new Date("2025-09-29") });
  });

  it("varianti regionali dello stesso provider: offerte distinte dello stesso modello", () => {
    const e = (key: string) => ({ ...BASE, source: "litellm" as const, key, litellmProvider: "bedrock", priceInput: 1, priceOutput: 2 });
    const { models, offers } = mergeUniversal(
      [e("us.anthropic.claude-x-v1:0"), e("eu.anthropic.claude-x-v1:0"), e("us.anthropic.claude-x-v1:0")],
      PROVIDER_REGISTRY,
      NOW,
    );
    expect(models).toHaveLength(1);
    expect(offers.map((o) => o.providerModelId)).toEqual(["us.anthropic.claude-x-v1:0", "eu.anthropic.claude-x-v1:0"]);
  });

  it("capacità del modello: vero se un'offerta è vera, falso se tutte false, altrimenti null; chat prevale su responses", () => {
    const l = (provider: string, over: Partial<SourceEntry>): SourceEntry => ({ ...BASE, source: "litellm", key: "m-1", litellmProvider: provider, priceInput: null, priceOutput: null, ...over });
    const run = (...es: SourceEntry[]) => mergeUniversal(es, PROVIDER_REGISTRY, NOW).models[0]!;
    expect(run(l("openai", { supportsTools: false }), l("azure", { supportsTools: true })).supportsTools).toBe(true);
    expect(run(l("openai", { supportsTools: false }), l("azure", { supportsTools: false })).supportsTools).toBe(false);
    expect(run(l("openai", { supportsTools: false }), l("azure", {})).supportsTools).toBeNull();
    expect(run(l("openai", { mode: "responses" }), l("azure", { mode: "chat" })).mode).toBe("chat");
  });

  it("la coppia di prezzi viene dalla prima fonte che li ha entrambi", () => {
    const { offers } = mergeUniversal(
      [
        { ...BASE, source: "litellm", key: "gemini/m", litellmProvider: "gemini", priceInput: 1, priceOutput: null },
        { ...BASE, source: "openrouter", key: "google/m", litellmProvider: null, priceInput: 2, priceOutput: 3 },
      ],
      PROVIDER_REGISTRY,
      NOW,
    );
    const r = offers.find((x) => x.provider === "gemini")!;
    expect([r.priceInput, r.priceOutput]).toEqual([2, 3]);
    expect(r.sources.price).toBe("openrouter");
  });
});

describe("mergeUniversal: indipendente dall'ordine delle voci", () => {
  const both = <T>(es: SourceEntry[], pick: (r: ReturnType<typeof mergeUniversal>) => T) => [
    pick(mergeUniversal(es, PROVIDER_REGISTRY, NOW)),
    pick(mergeUniversal([...es].reverse(), PROVIDER_REGISTRY, NOW)),
  ];
  const l = (over: Partial<SourceEntry>): SourceEntry => ({ ...BASE, source: "litellm", key: "x", litellmProvider: null, priceInput: null, priceOutput: null, ...over });

  it("alias dello stesso provider: vince l'alias che viene prima nel registro", () => {
    const [a, b] = both(
      [
        l({ key: "bedrock_mantle/anthropic.claude-opus-5-5", litellmProvider: "bedrock_mantle", priceInput: 4.4, priceOutput: 22 }),
        l({ key: "bedrock_converse/anthropic.claude-opus-5-5", litellmProvider: "bedrock_converse", priceInput: 4, priceOutput: 20 }),
      ],
      (r) => r.offers,
    );
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
    expect(a![0]!.priceInput).toBe(4);
    const [c, d] = both(
      [
        l({ key: "azure_ai/gpt-6-astra", litellmProvider: "azure_ai" }),
        l({ key: "azure/gpt-6-astra", litellmProvider: "azure", deprecationDate: new Date("2027-01-01") }),
      ],
      (r) => r.offers,
    );
    expect(c).toEqual(d);
    expect(c![0]!.status).toBe("deprecated");
  });

  it("nome, versione e rilascio dalla voce OpenRouter senza data in coda", () => {
    const or = (key: string, name: string, at: string): SourceEntry => ({ ...BASE, source: "openrouter", key, litellmProvider: null, name, releasedAt: new Date(at), priceInput: 1, priceOutput: 2 });
    const [a, b] = both(
      [or("openai/gpt-4o-2024-11-20", "OpenAI: GPT-4o (2024-11-20)", "2024-11-20"), or("openai/gpt-4o", "OpenAI: GPT-4o", "2024-05-13")],
      (r) => r.models,
    );
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
    expect(a![0]).toMatchObject({ canonicalKey: "gpt-4o", releasedAt: new Date("2024-05-13") });
    expect(a![0]!.version).not.toContain("2024");
  });

  it("tipo del modello con priorità fissa; nome scoperto deterministico", () => {
    const [a, b] = both(
      [l({ key: "img-1", litellmProvider: "openai", mode: "image_generation" }), l({ key: "img-1", litellmProvider: "azure", mode: "image_edit" })],
      (r) => r.models[0]!.mode,
    );
    expect([a, b]).toEqual(["image_edit", "image_edit"]);
    const [c, d] = both(
      [l({ key: "m", litellmProvider: "nuovo-x", mode: "completion" }), l({ key: "m", litellmProvider: "nuovo_x", mode: "responses" })],
      (r) => [r.models[0]!.mode, r.discovered],
    );
    expect(c).toEqual(d);
    // Stessa offerta da due nomi sconosciuti: vince il nome LiteLLM minore
    expect(c).toEqual(["completion", [{ slug: "nuovo-x", name: "nuovo-x", count: 2 }]]);
  });
});

describe("keepFailedOfferFields", () => {
  const offer = (over: Partial<OfferRecord> = {}): OfferRecord => ({
    provider: "bedrock", providerModelId: "us.m", canonicalKey: "m", priceInput: 1, priceOutput: 2, contextTokens: 100,
    supportsTools: true, status: "available", deprecationDate: null, sources: { price: "litellm", contextTokens: "litellm", supportsTools: "litellm" }, ...over,
  });

  it("senza fonti cadute non cambia nulla", () => {
    const recs = [offer()];
    expect(keepFailedOfferFields(recs, [offer({ priceInput: 9 })], [], NOW)).toBe(recs);
  });
  it("tiene i campi della fonte caduta, per provider e id presso il provider", () => {
    const before = [
      offer({ priceInput: 5, deprecationDate: new Date("2026-01-01"), sources: { price: "litellm", deprecationDate: "litellm" } }),
      offer({ providerModelId: "eu.m", priceInput: 7 }),
    ];
    const after = [
      offer({ priceInput: 2, priceOutput: 4, sources: { price: "openrouter" } }),
      offer({ provider: "anthropic", providerModelId: "us.m", priceInput: 3 }),
    ];
    const out = keepFailedOfferFields(after, before, ["litellm"], NOW);
    expect(out[0]).toMatchObject({ priceInput: 5, priceOutput: 2, status: "retired", sources: { price: "litellm", deprecationDate: "litellm" } });
    expect(out[1]!.priceInput).toBe(3);
  });
});

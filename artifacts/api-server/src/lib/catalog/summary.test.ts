import { describe, expect, it } from "vitest";
import type { OfferRecord } from "./merge";
import { summarizeOffers } from "./summary";

function offer(over: Partial<OfferRecord> = {}): OfferRecord {
  return {
    provider: "deepseek", providerModelId: "m", canonicalKey: "m", priceInput: 0.28, priceOutput: 1, contextTokens: null,
    supportsTools: null, status: "available", deprecationDate: null, sources: {}, ...over,
  };
}

describe("summarizeOffers", () => {
  const versions = new Map([["m", "v1"], ["old", "v1"], ["dep", "v1"], ["new", "v9"]]);
  const version = (o: OfferRecord) => versions.get(o.canonicalKey) ?? "";

  it("prima esecuzione: liste vuote", () => {
    expect(summarizeOffers([], [offer()], version)).toEqual({ firstRun: true, added: [], retired: [], deprecating: [], priceChanged: [] });
  });
  it("riconosce nuovo, ritirato, in dismissione e cambio di prezzo", () => {
    const at = (id: string, over: Partial<OfferRecord> = {}) => offer({ providerModelId: id, canonicalKey: id, ...over });
    const before = [offer(), at("old"), at("dep")];
    const after = [
      offer({ priceInput: 0.3 }),
      at("old", { status: "retired", deprecationDate: new Date("2026-06-17") }),
      at("dep", { status: "deprecated", deprecationDate: new Date("2027-01-31") }),
      at("new", { provider: "nuovo-provider" }),
    ];
    const s = summarizeOffers(before, after, version);
    expect(s.firstRun).toBe(false);
    expect(s.added).toEqual([{ provider: "nuovo-provider", modelId: "new", version: "v9" }]);
    expect(s.retired.map((c) => c.modelId)).toEqual(["old"]);
    expect(s.deprecating).toEqual([{ provider: "deepseek", modelId: "dep", version: "v1", deprecationDate: "2027-01-31" }]);
    expect(s.priceChanged).toEqual([
      { provider: "deepseek", modelId: "m", version: "v1", oldInput: 0.28, oldOutput: 1, newInput: 0.3, newOutput: 1 },
    ]);
  });
  it("prezzo da null a noto non è un cambio; deprecazione invariata non si ripete", () => {
    const dep = { status: "deprecated" as const, deprecationDate: new Date("2027-01-31") };
    const s = summarizeOffers(
      [offer({ priceInput: null, priceOutput: null }), offer({ providerModelId: "d", ...dep })],
      [offer({ priceInput: 1, priceOutput: 2 }), offer({ providerModelId: "d", ...dep })],
      version,
    );
    expect(s.priceChanged).toEqual([]);
    expect(s.deprecating).toEqual([]);
  });
});

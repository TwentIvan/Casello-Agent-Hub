import { describe, expect, it } from "vitest";
import { effectiveStatus, isAudioOnlyModel, isPreviewModel, isSelectable, pickRecommended, type EffectiveStatus } from "./model-status";

const NOW = new Date("2026-10-26T12:00:00Z");

describe("effectiveStatus", () => {
  it("ritirato dal catalogo anche se l'account lo dà disponibile", () => {
    expect(effectiveStatus({ availability: "available", catalogStatus: "retired", deprecationDate: null }, NOW)).toBe("retired");
  });
  it("ritirato se la data di dismissione è passata, anche con availability available", () => {
    const past = new Date("2026-10-01T00:00:00Z");
    expect(effectiveStatus({ availability: "available", catalogStatus: "deprecated", deprecationDate: past }, NOW)).toBe("retired");
    // Ritirato prima di non disponibile
    expect(effectiveStatus({ availability: "unavailable", catalogStatus: "available", deprecationDate: past }, NOW)).toBe("retired");
  });
  it("in dismissione con data futura resta disponibile", () => {
    const future = new Date("2027-01-01T00:00:00Z");
    expect(effectiveStatus({ availability: "unknown", catalogStatus: "deprecated", deprecationDate: future }, NOW)).toBe("available");
  });
  it("non disponibile se l'account lo segna così; sconosciuto o senza catalogo → disponibile", () => {
    expect(effectiveStatus({ availability: "unavailable", catalogStatus: null, deprecationDate: null }, NOW)).toBe("unavailable");
    expect(effectiveStatus({ availability: "unknown", catalogStatus: null, deprecationDate: null }, NOW)).toBe("available");
  });
});

describe("isPreviewModel", () => {
  it("riconosce preview, exp ed experimental come parola dell'id", () => {
    expect(isPreviewModel("antigravity-preview-latest")).toBe(true);
    expect(isPreviewModel("gemini-2.0-flash-exp")).toBe(true);
    expect(isPreviewModel("models/gemini-experimental")).toBe(true);
    expect(isPreviewModel("deepseek-expert")).toBe(false);
    expect(isPreviewModel("deepseek-chat")).toBe(false);
  });
});

describe("isAudioOnlyModel", () => {
  it("modelli solo vocali o audio: Live, audio nativo, trascrizione, sintesi, realtime", () => {
    for (const id of [
      "models/gemini-3.8-live",
      "models/gemini-3.8-live-extended-thinking",
      "models/gemini-3.1-flash-live-preview",
      "models/gemini-3.5-live-translate-preview",
      "models/gemini-3.5-transcribe-live",
      "models/gemini-2.5-flash-native-audio-latest",
      "models/gemini-2.5-flash-preview-tts",
      "gpt-4o-realtime-preview",
      "gpt-4o-audio-preview",
    ]) {
      expect(isAudioOnlyModel(id), id).toBe(true);
    }
  });

  it("i modelli di chat restano", () => {
    for (const id of ["models/gemini-3.1-flash-lite", "models/gemini-2.5-flash", "deepseek-chat", "olive-7b", "deliver-1", "sonnet"]) {
      expect(isAudioOnlyModel(id), id).toBe(false);
    }
  });
});

describe("isSelectable", () => {
  it("solo disponibili, con strumenti non esclusi e non solo audio", () => {
    expect(isSelectable("available", true, "deepseek-chat")).toBe(true);
    expect(isSelectable("available", null, "deepseek-chat")).toBe(true);
    expect(isSelectable("available", false, "deepseek-chat")).toBe(false);
    expect(isSelectable("unavailable", true, "deepseek-chat")).toBe(false);
    expect(isSelectable("retired", true, "deepseek-chat")).toBe(false);
    expect(isSelectable("available", true, "models/gemini-3.8-live")).toBe(false);
  });
});

describe("pickRecommended", () => {
  type M = { id: number; modelId: string; status: EffectiveStatus; supportsTools: boolean | null; priceInput: number | null; priceOutput: number | null };
  const m = (id: number, modelId: string, o: Partial<M> = {}): M => ({
    id,
    modelId,
    status: "available",
    supportsTools: true,
    priceInput: null,
    priceOutput: null,
    ...o,
  });

  it("il più economico con strumenti, scartando anteprime, ritirati e strumenti non noti", () => {
    const models = [
      m(1, "cheap-preview", { priceInput: 0.01, priceOutput: 0.01 }),
      m(2, "cheap-retired", { status: "retired", priceInput: 0.01, priceOutput: 0.01 }),
      m(3, "tools-unknown", { supportsTools: null, priceInput: 0.02, priceOutput: 0.02 }),
      m(4, "tools-pricey", { priceInput: 1, priceOutput: 2 }),
      m(5, "tools-cheap", { priceInput: 0.3, priceOutput: 0.5 }),
    ];
    expect(pickRecommended(models)).toBe(5);
  });

  it("senza prezzi → il primo con strumenti", () => {
    expect(pickRecommended([m(1, "a-preview"), m(2, "b", { supportsTools: null }), m(3, "c"), m(4, "d")])).toBe(3);
  });

  it("nessuno con strumenti → selezionabili non anteprima, poi tutti i selezionabili; altrimenti null", () => {
    expect(
      pickRecommended([
        m(1, "x-preview", { supportsTools: null, priceInput: 0.01, priceOutput: 0.01 }),
        m(2, "y", { supportsTools: null, priceInput: 1, priceOutput: 1 }),
        m(3, "z", { supportsTools: null, priceInput: 0.5, priceOutput: 0.5 }),
      ]),
    ).toBe(3);
    expect(pickRecommended([m(1, "x-preview", { supportsTools: null }), m(2, "y-exp", { supportsTools: null })])).toBe(1);
    expect(pickRecommended([m(1, "x", { supportsTools: false }), m(2, "y", { status: "unavailable" })])).toBeNull();
    expect(pickRecommended([])).toBeNull();
  });

  it("mai un modello solo audio, anche se è il più economico con strumenti", () => {
    expect(
      pickRecommended([
        m(1, "models/gemini-3.8-live", { priceInput: 0.01, priceOutput: 0.01 }),
        m(2, "models/gemini-3.1-flash-lite", { priceInput: 0.1, priceOutput: 0.4 }),
      ]),
    ).toBe(2);
    expect(pickRecommended([m(1, "models/gemini-3.8-live")])).toBeNull();
  });
});

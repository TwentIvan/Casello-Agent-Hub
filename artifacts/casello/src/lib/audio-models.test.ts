import { describe, expect, it } from "vitest";
import { otherModels } from "./audio-models";

const m = (modelId: string, supportsTools: boolean | null, status: "available" | "unavailable" | "retired" = "available") => ({
  modelId,
  supportsTools,
  status,
});

describe("otherModels", () => {
  it("disponibili senza strumenti, esclusi i modelli solo audio", () => {
    const models = [
      m("deepseek-reasoner", false),
      m("models/gemini-3.5-transcribe-live", false),
      m("models/gemini-3.5-live-translate-preview", false),
      m("models/gemini-2.5-flash-preview-tts", false),
      m("old-model", false, "retired"),
      m("deepseek-chat", true),
    ];
    expect(otherModels(models).map((x) => x.modelId)).toEqual(["deepseek-reasoner"]);
  });
});

import { describe, expect, it } from "vitest";
import { CHAT_ATTACHMENT_MESSAGES, attachmentSupportError, type ModelCapabilities } from "./support";

const model = (over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  provider: "openai",
  node: false,
  supportsVision: true,
  supportsPdf: true,
  ...over,
});

describe("il modello legge gli allegati?", () => {
  it("senza allegati nessun controllo", () => {
    expect(attachmentSupportError(model({ node: true }), [])).toBeNull();
  });

  it("Claude Code (nodo) rifiuta ogni allegato, anche le immagini", () => {
    expect(attachmentSupportError(model({ node: true }), ["image/png"])).toBe(CHAT_ATTACHMENT_MESSAGES.node);
  });

  it("immagini: rifiutate solo se l'offerta dice che il modello non ha la visione", () => {
    expect(attachmentSupportError(model({ supportsVision: false }), ["image/jpeg"])).toBe(CHAT_ATTACHMENT_MESSAGES.noVision);
    expect(attachmentSupportError(model({ supportsVision: null, provider: "custom" }), ["image/jpeg"])).toBeNull();
    expect(attachmentSupportError(model({ supportsVision: true, provider: "deepseek" }), ["image/webp"])).toBeNull();
  });

  it("PDF: solo OpenAI (con l'offerta che li accetta o non nota) e OpenRouter (ogni modello)", () => {
    expect(attachmentSupportError(model(), ["application/pdf"])).toBeNull();
    expect(attachmentSupportError(model({ supportsPdf: null }), ["application/pdf"])).toBeNull();
    expect(attachmentSupportError(model({ supportsPdf: false }), ["application/pdf"])).toBe(CHAT_ATTACHMENT_MESSAGES.noPdf);
    expect(attachmentSupportError(model({ provider: "openrouter", supportsPdf: false }), ["application/pdf"])).toBeNull();
    expect(attachmentSupportError(model({ provider: "gemini" }), ["application/pdf"])).toBe(CHAT_ATTACHMENT_MESSAGES.noPdf);
    expect(attachmentSupportError(model({ provider: "custom" }), ["image/png", "application/pdf"])).toBe(CHAT_ATTACHMENT_MESSAGES.noPdf);
  });
});

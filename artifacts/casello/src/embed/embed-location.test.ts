import { describe, expect, it } from "vitest";
import { EMBED_PATH, consoleLinkHref } from "./embed-location";

describe("consoleLinkHref", () => {
  const origin = "https://casello.fantamister.cloud";
  it("i percorsi della console diventano indirizzi assoluti su Botcave", () => {
    expect(consoleLinkHref("/pending-actions", origin)).toBe("https://casello.fantamister.cloud/pending-actions");
    expect(consoleLinkHref("/analyses/12", origin)).toBe("https://casello.fantamister.cloud/analyses/12");
  });
  it("un indirizzo di un'altra origine non esce da Botcave", () => {
    expect(consoleLinkHref("https://example.com/x", origin)).toBe("https://casello.fantamister.cloud/");
    expect(consoleLinkHref("//example.com/x", origin)).toBe("https://casello.fantamister.cloud/");
  });
  it("il percorso del pannello è fisso", () => {
    expect(EMBED_PATH).toBe("/embed");
  });
});

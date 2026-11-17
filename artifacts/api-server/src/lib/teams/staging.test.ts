import { describe, expect, it } from "vitest";
import { STAGING_MESSAGES, checkStagingBranch, checkStagingUrl } from "./staging";

describe("checkStagingBranch", () => {
  it("accetta un branch di prova normale", () => {
    expect(checkStagingBranch("staging", "main")).toBeNull();
    expect(checkStagingBranch("prova/web", null)).toBeNull();
  });

  it("rifiuta il base, main, master e i branch di Botcave", () => {
    for (const [name, base] of [
      ["develop", "develop"],
      ["main", null],
      ["master", "develop"],
      ["botcave/x", "main"],
    ] as const) {
      expect(checkStagingBranch(name, base), name).toBe(STAGING_MESSAGES.branch);
    }
  });

  it("rifiuta i nomi non validi per Git", () => {
    for (const name of ["", "a..b", "x.lock", "con spazio", "fine/", "/inizio", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "@", "x".repeat(101)]) {
      expect(checkStagingBranch(name, "main"), JSON.stringify(name)).toBe(STAGING_MESSAGES.branch);
    }
  });
});

describe("checkStagingUrl", () => {
  it("accetta un indirizzo https", () => {
    expect(checkStagingUrl("https://staging.hubup.fantamister.cloud")).toBeNull();
  });

  it("rifiuta http, testo e indirizzi troppo lunghi", () => {
    for (const url of ["http://staging.example.com", "staging", `https://a.example.com/${"x".repeat(500)}`]) {
      expect(checkStagingUrl(url)).toBe(STAGING_MESSAGES.url);
    }
  });
});

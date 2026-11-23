import { afterEach, describe, expect, it } from "vitest";
import { APP_BOOTSTRAP_MESSAGES as M } from "./messages";
import { bootstrapNames, defaultDomain, normalizeDomain, validateSlug } from "./naming";

afterEach(() => {
  delete process.env["PUBLIC_APP_URL"];
  delete process.env["APP_BASE_DOMAIN"];
});

describe("validateSlug", () => {
  it("accetta, riserva e rifiuta", () => {
    expect(validateSlug("portfolio")).toBeNull();
    expect(validateSlug("casello")).toBe(M.slugReserved);
    expect(validateSlug("Porta")).toBe(M.slugInvalid);
    expect(validateSlug("-a")).toBe(M.slugInvalid);
    expect(validateSlug("a".repeat(65))).toBe(M.slugInvalid);
  });
});

describe("normalizeDomain", () => {
  it("normalizza", () => {
    expect(normalizeDomain(" Portfolio.Example.COM. ")).toEqual({ ok: true, domain: "portfolio.example.com" });
  });
  it("rifiuta IP, localhost, host di Botcave, etichette sbagliate", () => {
    process.env["PUBLIC_APP_URL"] = "https://casello.fantamister.cloud";
    for (const d of ["1.2.3.4", "localhost", "a.localhost", "casello.fantamister.cloud", "solo", "-a.com", "a_b.com", ""]) {
      expect(normalizeDomain(d).ok).toBe(false);
    }
  });
});

describe("nomi", () => {
  it("dominio predefinito e nomi", () => {
    process.env["APP_BASE_DOMAIN"] = "Example.com";
    expect(defaultDomain("portfolio")).toBe("portfolio.example.com");
    expect(bootstrapNames("portfolio", "TwentIvan")).toEqual({
      apiImage: "ghcr.io/twentivan/portfolio-api",
      webImage: "ghcr.io/twentivan/portfolio-web",
      apiService: "portfolio-api",
      webService: "portfolio-web",
      webDir: "artifacts/portfolio-web",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  checklistLed,
  domainFollowsSlug,
  readBootstrapArgs,
  repoMatchesSlug,
  slugFromName,
  suggestedDomain,
  templateGenerateUrl,
} from "./app-bootstrap";

const item = { key: "k", label: "L", detail: "d", auto: false, done: false, doneAt: null };

describe("app-bootstrap", () => {
  it("propone il dominio dallo slug", () => {
    expect(suggestedDomain("portfolio")).toBe("portfolio.fantamister.cloud");
    expect(suggestedDomain("portfolio", "example.org")).toBe("portfolio.example.org");
  });

  it("il dominio segue lo slug finché è quello proposto", () => {
    expect(domainFollowsSlug("portfolio.fantamister.cloud", "portfolio")).toBe(true);
    expect(domainFollowsSlug("altro.example.org", "portfolio")).toBe(false);
    expect(domainFollowsSlug("", "")).toBe(true);
  });

  it("il repository deve chiamarsi come lo slug", () => {
    expect(repoMatchesSlug("TwentIvan/Portfolio", "portfolio")).toBe(true);
    expect(repoMatchesSlug("TwentIvan/altro", "portfolio")).toBe(false);
    expect(repoMatchesSlug("portfolio", "portfolio")).toBe(false);
  });

  it("indirizzo per generare dal modello", () => {
    expect(templateGenerateUrl("TwentIvan/Modello")).toBe("https://github.com/TwentIvan/Modello/generate");
  });

  it("slug dal nome", () => {
    expect(slugFromName("Il Mio Portfolio!")).toBe("il-mio-portfolio");
    expect(slugFromName("  --Àgenda 2 ")).toBe("agenda-2");
  });

  it("LED della checklist", () => {
    expect(checklistLed({ ...item, done: true })).toBe("ok");
    expect(checklistLed(item)).toBe("idle");
    expect(checklistLed({ ...item, key: "health" }, { healthCheckedAt: "x", healthOkAt: null })).toBe("work");
    expect(checklistLed({ ...item, key: "health" }, { healthCheckedAt: null, healthOkAt: null })).toBe("idle");
    expect(checklistLed({ ...item, key: "health", done: true }, { healthCheckedAt: "x", healthOkAt: "y" })).toBe("ok");
  });

  it("legge gli argomenti della voce", () => {
    const a = readBootstrapArgs({ bootstrapId: 3, name: "P", slug: "p", domain: "p.x.y", repo: "o/p", names: { apiService: "p-api" }, steps: ["a", 1, "b"], analysisEstimateUsd: 1.5, monthly: "m" });
    expect(a.steps).toEqual(["a", "b"]);
    expect(a.bootstrapId).toBe(3);
    expect(a.analysisEstimateUsd).toBe(1.5);
    expect(readBootstrapArgs(null).steps).toEqual([]);
  });
});

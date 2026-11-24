import { describe, expect, it } from "vitest";
import { autoReanalysisAvailable, autoReanalysisLabel } from "./reanalysis";

describe("rianalisi automatica", () => {
  it("serve GitHub tramite installazione", () => {
    expect(autoReanalysisAvailable({ sourceType: "github", sourceRepo: "ivan/fanta", sourceInstallationId: 7 })).toBe(true);
    expect(autoReanalysisAvailable({ sourceType: "github", sourceRepo: "ivan/fanta", sourceInstallationId: null })).toBe(false);
    expect(autoReanalysisAvailable({ sourceType: "zip", sourceRepo: null, sourceInstallationId: null })).toBe(false);
  });

  it("etichetta solo le analisi automatiche", () => {
    expect(autoReanalysisLabel({ triggerCommit: "abcdef0123456789" })).toBe("automatica · commit abcdef0");
    expect(autoReanalysisLabel({ triggerCommit: null })).toBeNull();
  });
});

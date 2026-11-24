import { describe, expect, it } from "vitest";
import { auditActionLabel, auditDetailText, auditObjectLabel, auditViaLabel } from "./audit-events";

describe("testi del registro delle azioni", () => {
  it("azioni note tradotte, sconosciute come sono", () => {
    expect(auditActionLabel("api_token.create")).toBe("Token personale creato");
    expect(auditActionLabel("nuova.azione")).toBe("nuova.azione");
  });

  it("oggetto, canale e dettaglio", () => {
    expect(auditObjectLabel("api_token", "7")).toBe("token #7");
    expect(auditObjectLabel("character", "lucius")).toBe("personaggio lucius");
    expect(auditObjectLabel(null, null)).toBeNull();
    expect(auditViaLabel("token", 3)).toBe("token personale #3");
    expect(auditViaLabel("session", null)).toBe("console");
    expect(auditDetailText({ scopes: ["api:read"], keyChanged: false, ignoto: "x" })).toBe("ambiti api:read");
    expect(auditDetailText({ provider: "github" })).toBe("con GitHub");
    expect(auditDetailText(null)).toBeNull();
  });
});

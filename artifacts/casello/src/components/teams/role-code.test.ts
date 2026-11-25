import { describe, expect, it } from "vitest";
import { placeRole, selectableCodeOptions } from "./role-draft";
import { ciLabel } from "./task-code";

describe("tendina «Codice» del ruolo", () => {
  it("con GitHub offre tutti i valori del luogo", () => {
    expect(selectableCodeOptions("cloud", "none", true, false)).toEqual(["none", "read", "write", "merge"]);
    expect(selectableCodeOptions("node", "none", true, false)).toEqual(["none", "write"]);
  });

  it("senza GitHub solo «Nessuno» più il valore attuale, per poter tornare a «Nessuno»", () => {
    expect(selectableCodeOptions("cloud", "none", false, false)).toEqual(["none"]);
    expect(selectableCodeOptions("cloud", "write", false, false)).toEqual(["none", "write"]);
    expect(selectableCodeOptions("node", "read", false, false)).toEqual(["none"]);
  });

  it("per il capo solo «Nessuno» e «Scrittura e merge» (più il valore attuale)", () => {
    expect(selectableCodeOptions("cloud", "none", true, true)).toEqual(["none", "merge"]);
    expect(selectableCodeOptions("cloud", "read", true, true)).toEqual(["none", "merge", "read"]);
    expect(selectableCodeOptions("cloud", "none", false, true)).toEqual(["none"]);
    expect(selectableCodeOptions("node", "none", true, true)).toEqual(["none"]);
  });
});

describe("testo della CI", () => {
  it("in corso, non ancora letta, senza PR", () => {
    expect(ciLabel({ prNumber: 5, ciState: "pending" })).toBe("CI in corso");
    expect(ciLabel({ prNumber: 5, ciState: null })).toBe("CI non ancora letta");
    expect(ciLabel({ prNumber: null, ciState: null })).toBe("Nessuna PR");
    expect(ciLabel({ prNumber: 5, ciState: "none" })).toBe("Nessuna CI");
  });
});

describe("dove gira un ruolo, dedotto dal modello", () => {
  const nodeIds = new Set([20]);
  const role = { isLead: false, code: "merge" as const };

  it("un modello Claude Code porta sul Mac un ruolo che non è il capo, e il codice si adatta", () => {
    expect(placeRole(role, 20, nodeIds)).toEqual({ aiModelId: 20, runsOn: "node", code: "none" });
    expect(placeRole({ isLead: false, code: "write" }, 20, nodeIds)).toEqual({ aiModelId: 20, runsOn: "node", code: "write" });
  });

  it("un modello cloud o nessun modello lo lascia in cloud", () => {
    expect(placeRole(role, 10, nodeIds)).toEqual({ aiModelId: 10, runsOn: "cloud", code: "merge" });
    expect(placeRole(role, null, nodeIds)).toEqual({ aiModelId: null, runsOn: "cloud", code: "merge" });
  });

  it("«Claude Code sul Mac (modello predefinito)» = sul Mac senza modello", () => {
    expect(placeRole(role, 10, nodeIds, true)).toEqual({ aiModelId: null, runsOn: "node", code: "none" });
  });

  it("il capo resta in Botcave anche con un modello Claude Code", () => {
    expect(placeRole({ isLead: true, code: "merge" }, 20, nodeIds)).toEqual({ aiModelId: 20, runsOn: "cloud", code: "merge" });
  });
});

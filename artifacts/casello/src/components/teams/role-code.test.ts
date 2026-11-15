import { describe, expect, it } from "vitest";
import { selectableCodeOptions } from "./role-draft";
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

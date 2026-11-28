import { describe, expect, it } from "vitest";
import { addLink, linkProblem, linksFromApi, linksToApi, makeDouble, pruneDraftLinks, reverseLink, type LinkRole } from "./role-links";

const roles: LinkRole[] = [
  { uid: "u0", key: "capo", name: "Capo", isLead: true, runsOn: "cloud" },
  { uid: "u1", key: "dev", name: "Sviluppatore", isLead: false, runsOn: "cloud" },
  { uid: "u2", key: "", name: "Revisore", isLead: false, runsOn: "cloud" },
  { uid: "u3", key: "mac", name: "Mac", isLead: false, runsOn: "node" },
];

describe("relazioni nell'editor", () => {
  it("regole: capo, sé stesso, mittente sul nodo; verso il nodo solo messaggi", () => {
    expect(linkProblem(roles, "u1", "u2")).toBeNull();
    expect(linkProblem(roles, "u0", "u1")).toContain("capo");
    expect(linkProblem(roles, "u1", "u1")).toContain("sé stesso");
    expect(linkProblem(roles, "u3", "u1")).toContain("nodo");
    expect(addLink(roles, [], { from: "u1", to: "u3", mode: "full" })).toEqual([{ from: "u1", to: "u3", mode: "notes" }]);
    expect(addLink(roles, [], { from: "u0", to: "u1", mode: "full" })).toBeNull();
  });

  it("inverti, rendi doppia e potatura", () => {
    const one = [{ from: "u1", to: "u2", mode: "full" as const }];
    expect(reverseLink(roles, one, one[0]!)).toEqual([{ from: "u2", to: "u1", mode: "full" }]);
    expect(makeDouble(roles, one, one[0]!)).toEqual([...one, { from: "u2", to: "u1", mode: "full" }]);
    // Verso il nodo non si inverte (il nodo non può mandare)
    const toMac = [{ from: "u1", to: "u3", mode: "notes" as const }];
    expect(reverseLink(roles, toMac, toMac[0]!)).toEqual(toMac);
    expect(pruneDraftLinks(roles.slice(0, 2), one)).toEqual([]);
  });

  it("da e verso l'API: chiavi al posto degli uid, ruoli nuovi con la chiave assegnata al salvataggio", () => {
    expect(linksFromApi(roles, [{ from: "dev", to: "mac", mode: "notes" }, { from: "dev", to: "sparito", mode: "full" }])).toEqual([
      { from: "u1", to: "u3", mode: "notes" },
    ]);
    const keyed = roles.map((r) => (r.key ? r : { ...r, key: "revisore" }));
    expect(linksToApi(keyed, [{ from: "u1", to: "u2", mode: "full" }])).toEqual([{ from: "dev", to: "revisore", mode: "full" }]);
  });
});

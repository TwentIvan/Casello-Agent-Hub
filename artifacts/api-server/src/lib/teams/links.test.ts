import { describe, expect, it } from "vitest";
import { LINK_MESSAGES, MAX_LINKS, linksError, outgoingLinks, pruneLinks, readLinks, type RoleLink } from "./links";

// Regole delle relazioni tra i ruoli (modulo puro)

const roles = [
  { key: "capo", isLead: true, runsOn: "cloud" as const },
  { key: "dev", isLead: false, runsOn: "cloud" as const },
  { key: "rev", isLead: false, runsOn: "cloud" as const },
  { key: "mac", isLead: false, runsOn: "node" as const },
];

const link = (from: string, to: string, mode: RoleLink["mode"] = "full"): RoleLink => ({ from, to, mode });

describe("linksError", () => {
  it("accetta relazioni valide, anche doppie e «solo messaggi» verso un ruolo sul nodo", () => {
    expect(linksError(roles, [link("dev", "rev"), link("rev", "dev"), link("dev", "mac", "notes")])).toBeNull();
    expect(linksError(roles, [])).toBeNull();
  });

  it("rifiuta forma, ripetizioni, sé stesso, ruoli sconosciuti, il capo e le regole del nodo", () => {
    expect(linksError(roles, [{ from: "dev", to: "rev", mode: "altro" }])).toBe(LINK_MESSAGES.invalid);
    expect(linksError(roles, "x")).toBe(LINK_MESSAGES.invalid);
    expect(linksError(roles, [link("dev", "dev")])).toBe(LINK_MESSAGES.self);
    expect(linksError(roles, [link("dev", "zzz")])).toBe(LINK_MESSAGES.unknownRole("zzz"));
    expect(linksError(roles, [link("capo", "dev")])).toBe(LINK_MESSAGES.lead);
    expect(linksError(roles, [link("dev", "capo")])).toBe(LINK_MESSAGES.lead);
    expect(linksError(roles, [link("dev", "rev"), link("dev", "rev", "notes")])).toBe(LINK_MESSAGES.duplicate);
    expect(linksError(roles, [link("mac", "dev", "notes")])).toBe(LINK_MESSAGES.nodeSender);
    expect(linksError(roles, [link("dev", "mac")])).toBe(LINK_MESSAGES.nodeTargetFull);
  });

  it("al più MAX_LINKS relazioni", () => {
    const many = Array.from({ length: MAX_LINKS + 1 }, () => link("dev", "rev"));
    expect(linksError(roles, many)).toBe(LINK_MESSAGES.tooMany);
  });
});

describe("pruneLinks e letture", () => {
  it("toglie le frecce dei ruoli spariti o non ammessi e riduce a notes quelle verso il nodo", () => {
    const pruned = pruneLinks(roles, [link("dev", "rev"), link("dev", "sparito"), link("capo", "dev"), link("mac", "dev"), link("rev", "mac"), link("dev", "rev")]);
    expect(pruned).toEqual([link("dev", "rev"), link("rev", "mac", "notes")]);
  });

  it("outgoingLinks e readLinks", () => {
    const all = [link("dev", "rev"), link("rev", "dev")];
    expect(outgoingLinks(all, "dev")).toEqual([link("dev", "rev")]);
    expect(readLinks([link("dev", "rev"), { from: 1 }, null])).toEqual([link("dev", "rev")]);
    expect(readLinks(null)).toEqual([]);
  });
});

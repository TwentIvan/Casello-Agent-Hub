import { describe, expect, it } from "vitest";
import type { TeamReadiness, TeamReadinessProblem, TeamReadinessRole } from "@workspace/api-client-react";
import { activateLabel, blockingProblems, roleLed } from "./team-readiness";

const p = (level: "error" | "warning", message = "m"): TeamReadinessProblem => ({ code: "c", level, message, link: null });
const role = (roleName: string, problems: TeamReadinessProblem[]): TeamReadinessRole => ({ roleKey: roleName, roleName, problems });

describe("roleLed", () => {
  it("nessun problema: ok", () => expect(roleLed(role("A", []))).toBe("ok"));
  it("solo avvisi: ask", () => expect(roleLed(role("A", [p("warning")]))).toBe("ask"));
  it("almeno un errore: ko", () => expect(roleLed(role("A", [p("warning"), p("error")]))).toBe("ko"));
});

describe("blockingProblems", () => {
  it("solo gli errori, nell'ordine dei ruoli", () => {
    const r: TeamReadiness = {
      roles: [role("A", [p("warning", "w"), p("error", "e1")]), role("B", [p("warning")]), role("C", [p("error", "e2"), p("error", "e3")])],
    };
    expect(blockingProblems(r)).toEqual([
      { roleName: "A", message: "e1" },
      { roleName: "C", message: "e2" },
      { roleName: "C", message: "e3" },
    ]);
  });
});

describe("activateLabel", () => {
  it("senza dati o senza errori: Attiva", () => {
    expect(activateLabel(undefined)).toBe("Attiva");
    expect(activateLabel({ roles: [role("A", [p("warning")])] })).toBe("Attiva");
  });
  it("con errori: Attiva comunque", () => expect(activateLabel({ roles: [role("A", [p("error")])] })).toBe("Attiva comunque"));
});

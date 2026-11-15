import { describe, expect, it } from "vitest";
import type { AnalysisItem, TeamInstance } from "@workspace/api-client-react";
import { implementableItems, implementMessage, implementTeams, MAX_LEAD_MESSAGE, planTeamRef } from "./implement-plan";

const item = (id: number, chapter: AnalysisItem["chapter"], status: AnalysisItem["status"]) =>
  ({ id, chapter, status }) as AnalysisItem;
const team = (id: number, appId: number, status: TeamInstance["status"]) => ({ id, status, ref: { appId } }) as TeamInstance;

describe("implementableItems", () => {
  it("solo approvate nei capitoli del piano", () => {
    const items = [
      item(1, "endpoint", "approved"),
      item(2, "completion", "approved"),
      item(3, "evolution", "approved"),
      item(4, "tool", "approved"),
      item(5, "completion", "pending"),
    ];
    expect(implementableItems(items).map((i) => i.id)).toEqual([1, 2, 3]);
  });
});

describe("implementTeams", () => {
  it("squadre dell'App non chiuse, prima le attive e le più recenti", () => {
    const teams = [team(1, 7, "draft"), team(2, 7, "active"), team(3, 7, "closed"), team(4, 8, "active"), team(5, 7, "draft")];
    expect(implementTeams(teams, 7).map((t) => t.id)).toEqual([2, 5, 1]);
  });
});

describe("planTeamRef", () => {
  it("riferimento «piano» con l'id dell'App", () => {
    expect(planTeamRef(7, "TradeFlow")).toEqual({ appId: 7, type: "piano", id: "7", title: "Piano di TradeFlow" });
  });
});

describe("implementMessage", () => {
  it("senza voci: tutto il piano approvato e leggi_piano_app", () => {
    const msg = implementMessage("TradeFlow", []);
    expect(msg).toContain("«TradeFlow»");
    expect(msg).toContain("tutte le voci approvate");
    expect(msg).toContain("leggi_piano_app");
  });

  it("con le voci: id, titolo su una riga e issue", () => {
    const msg = implementMessage("TradeFlow", [
      { id: 12, title: "Calcolo\n margini", issueNumber: 40 },
      { id: 13, title: "Export CSV", issueNumber: null },
    ]);
    expect(msg).toContain("queste 2 voci");
    expect(msg).toContain("- #12 Calcolo margini (issue #40)");
    expect(msg).toContain("- #13 Export CSV\n");
  });

  it("una voce: singolare", () => {
    expect(implementMessage("A", [{ id: 1, title: "x", issueNumber: null }])).toContain("solo su questa voce");
  });

  it("molte voci lunghe: resta sotto il limite e conta le altre", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, title: "t".repeat(300), issueNumber: i }));
    const msg = implementMessage("A", items);
    expect(msg.length).toBeLessThanOrEqual(MAX_LEAD_MESSAGE);
    expect(msg).toMatch(/- e altre \d+ voci\n/);
    expect(msg).toContain("…");
  });
});

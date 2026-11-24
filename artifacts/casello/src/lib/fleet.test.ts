import { describe, expect, it } from "vitest";
import type { FleetAgent } from "@workspace/api-client-react";
import { filterFleet, finishedRunsText, fleetIssuesText, fleetLimitsError, formatSuccessRate } from "./fleet";

const agent = (over: Partial<FleetAgent>): FleetAgent =>
  ({ agentId: 1, appId: 1, health: "healthy", issues: [], succeeded24h: 0, failed24h: 0, ...over }) as FleetAgent;

describe("flotta degli agenti", () => {
  it("testi dei problemi, del tasso e delle run", () => {
    expect(fleetIssuesText([])).toBeNull();
    expect(fleetIssuesText(["no_model", "backlog"])).toBe("senza modello · coda lunga");
    expect(formatSuccessRate(null)).toBe("—");
    expect(formatSuccessRate(2 / 3)).toBe("67 %");
    expect(finishedRunsText({ succeeded24h: 0, failed24h: 0 })).toBe("nessuna");
    expect(finishedRunsText({ succeeded24h: 1, failed24h: 2 })).toBe("1 riuscita · 2 fallite");
  });

  it("limiti come sul server", () => {
    expect(fleetLimitsError(6, 2)).toBeNull();
    expect(fleetLimitsError(0, 1)).toContain("in tutto");
    expect(fleetLimitsError(6, 11)).toContain("per agente");
    expect(fleetLimitsError(3, 4)).toBe("Il limite per agente non può superare quello totale");
  });

  it("filtri per salute e app", () => {
    const list = [agent({ agentId: 1, health: "failing" }), agent({ agentId: 2, health: "degraded", appId: 2 }), agent({ agentId: 3 })];
    expect(filterFleet(list, "attention", null).map((a) => a.agentId)).toEqual([1, 2]);
    expect(filterFleet(list, "attention", 2).map((a) => a.agentId)).toEqual([2]);
    expect(filterFleet(list, "healthy", null).map((a) => a.agentId)).toEqual([3]);
    expect(filterFleet(list, "all", null)).toHaveLength(3);
  });
});

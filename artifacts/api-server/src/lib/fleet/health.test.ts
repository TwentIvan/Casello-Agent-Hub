import { describe, expect, it } from "vitest";
import { fleetHealth, successRate, type FleetHealthInput } from "./health";
import { checkLimits, cleanPauseReason, FLEET_MESSAGES } from "./policy";

const base: FleetHealthInput = {
  status: "active",
  hasModel: true,
  succeeded: 0,
  failed: 0,
  triggersInError: 0,
  pendingRuns: 0,
  stuckRuns: 0,
};

describe("salute degli agenti", () => {
  it("agente non attivo: spento, senza problemi", () => {
    expect(fleetHealth({ ...base, status: "inactive", hasModel: false, failed: 9 })).toEqual({ health: "off", issues: [] });
    expect(fleetHealth({ ...base, status: "draft" }).health).toBe("off");
  });

  it("attivo senza run: sano", () => {
    expect(fleetHealth(base)).toEqual({ health: "healthy", issues: [] });
  });

  it("senza modello o con un innesco in errore: fallisce", () => {
    expect(fleetHealth({ ...base, hasModel: false })).toEqual({ health: "failing", issues: ["no_model"] });
    expect(fleetHealth({ ...base, triggersInError: 1 })).toEqual({ health: "failing", issues: ["trigger_error"] });
  });

  it("tasso di successo: meno della metà su almeno 3 run fallisce, altrimenti qualche errore rallenta", () => {
    expect(fleetHealth({ ...base, succeeded: 1, failed: 2 })).toEqual({ health: "failing", issues: ["high_failure"] });
    // Solo 2 run concluse: troppo poche per giudicare dal tasso
    expect(fleetHealth({ ...base, failed: 2 })).toEqual({ health: "degraded", issues: ["some_failures"] });
    expect(fleetHealth({ ...base, succeeded: 9, failed: 1 })).toEqual({ health: "degraded", issues: ["some_failures"] });
  });

  it("coda lunga e run bloccate rallentano", () => {
    expect(fleetHealth({ ...base, pendingRuns: 20 })).toEqual({ health: "degraded", issues: ["backlog"] });
    expect(fleetHealth({ ...base, pendingRuns: 19 }).health).toBe("healthy");
    expect(fleetHealth({ ...base, stuckRuns: 1, pendingRuns: 25 })).toEqual({ health: "degraded", issues: ["stuck_run", "backlog"] });
  });

  it("tasso di successo", () => {
    expect(successRate(0, 0)).toBeNull();
    expect(successRate(3, 1)).toBe(0.75);
  });
});

describe("regole della politica", () => {
  it("limiti negli intervalli e per agente non oltre il totale", () => {
    expect(checkLimits(6, 2)).toEqual({ ok: true });
    expect(checkLimits(20, 10)).toEqual({ ok: true });
    for (const [t, a] of [[0, 1], [21, 2], [6, 0], [6, 11], [3, 4], [2.5, 1], ["6", 2]] as const) {
      expect(checkLimits(t, a)).toEqual({ ok: false, error: FLEET_MESSAGES.invalidLimits });
    }
  });

  it("motivo della pausa: facoltativo, una riga, ≤ 300 caratteri, niente credenziali", () => {
    expect(cleanPauseReason(undefined)).toEqual({ ok: true, value: null });
    expect(cleanPauseReason("  ")).toEqual({ ok: true, value: null });
    expect(cleanPauseReason(" manutenzione ")).toEqual({ ok: true, value: "manutenzione" });
    for (const bad of ["a".repeat(301), "riga\naltra", "sk-abcdefghijklmnopqrstuvwxyz0123", 5]) {
      expect(cleanPauseReason(bad)).toEqual({ ok: false, error: FLEET_MESSAGES.invalidReason });
    }
  });
});

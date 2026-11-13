import { describe, expect, it } from "vitest";
import { STALE_TURN_MS, abortTurn, isLiveTurn, liveTurns, sweepStaleTurns, trackTurn, type StaleTurnFilter } from "./stale-turns";

describe("turni di chat appesi", () => {
  it("trackTurn segna il turno vivo finché gira, anche se fallisce", async () => {
    let inside: number[] = [];
    await trackTurn("plan", 7, async () => {
      inside = liveTurns("plan");
    });
    expect(inside).toEqual([7]);
    expect(liveTurns("plan")).toEqual([]);
    await expect(trackTurn("team", 3, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(liveTurns("team")).toEqual([]);
  });

  it("il giro passa a ogni chat la soglia e i turni vivi, e un errore non ferma gli altri", async () => {
    const seen: Record<string, StaleTurnFilter> = {};
    let total = 0;
    await trackTurn("character", 42, async () => {
      total = await sweepStaleTurns(
        {
          plan: async (f) => ((seen.plan = f), 2),
          character: async (f) => ((seen.character = f), 1),
          team: async () => Promise.reject(new Error("db")),
        },
        1_000_000,
      );
    });
    expect(total).toBe(3);
    expect(seen.plan!.olderThan.getTime()).toBe(1_000_000 - STALE_TURN_MS);
    expect(seen.plan!.exclude).toEqual([]);
    expect(seen.character!.exclude).toEqual([42]);
  });
});

describe("registro dei turni: interruzione", () => {
  it("abortTurn annulla il segnale del turno in corso e restituisce true", async () => {
    let aborted = false;
    await trackTurn("plan", 11, async (signal) => {
      expect(isLiveTurn("plan", 11)).toBe(true);
      expect(signal.aborted).toBe(false);
      expect(abortTurn("plan", 11)).toBe(true);
      aborted = signal.aborted;
    });
    expect(aborted).toBe(true);
  });

  it("false a turno finito e per una conversazione mai vista", async () => {
    await trackTurn("team", 12, async () => {});
    expect(abortTurn("team", 12)).toBe(false);
    expect(isLiveTurn("team", 12)).toBe(false);
    expect(abortTurn("character", 999)).toBe(false);
  });
});

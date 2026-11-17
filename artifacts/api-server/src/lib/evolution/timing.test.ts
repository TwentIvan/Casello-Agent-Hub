import { describe, it, expect } from "vitest";
import { backoffMs, FREQUENCY_MS, nextRoundAt } from "./timing";

describe("tempi del ciclo", () => {
  it("il prossimo giro aggiunge la frequenza", () => {
    const t = new Date("2026-11-16T10:00:00Z");
    expect(nextRoundAt(t, "daily").toISOString()).toBe("2026-11-17T10:00:00.000Z");
    expect(FREQUENCY_MS.weekly).toBe(7 * 86_400_000);
  });
  it("l'attesa dopo gli errori raddoppia fino a 24 ore", () => {
    expect(backoffMs(0)).toBe(1_800_000);
    expect(backoffMs(1)).toBe(3_600_000);
    expect(backoffMs(10)).toBe(86_400_000);
  });
});

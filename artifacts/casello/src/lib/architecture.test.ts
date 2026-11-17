import { describe, expect, it } from "vitest";
import { architectureLed, lineDiff, REFRESH_LABELS } from "./architecture";

const base = { status: "idle", summary: null } as Parameters<typeof architectureLed>[0];

describe("architectureLed", () => {
  it("running è work", () => {
    expect(architectureLed({ ...base, status: "running", summary: "x" })).toBe("work");
  });
  it("error è ko", () => {
    expect(architectureLed({ ...base, status: "error", summary: "x" })).toBe("ko");
  });
  it("con la sintesi è ok", () => {
    expect(architectureLed({ ...base, summary: "x" })).toBe("ok");
  });
  it("senza sintesi è idle", () => {
    expect(architectureLed(base)).toBe("idle");
  });
});

describe("REFRESH_LABELS", () => {
  it("ha le cinque frequenze", () => {
    expect(REFRESH_LABELS).toEqual({
      off: "Spento",
      hourly: "Ogni ora",
      "6h": "Ogni 6 ore",
      daily: "Ogni giorno",
      weekly: "Ogni settimana",
    });
  });
});

describe("lineDiff", () => {
  it("righe uguali", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
  });
  it("righe aggiunte", () => {
    expect(lineDiff("a\nc", "a\nb\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "added", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });
  it("righe tolte", () => {
    expect(lineDiff("a\nb\nc", "a\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });
  it("riga cambiata = tolta e aggiunta", () => {
    expect(lineDiff("a\nb", "a\nB")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
    ]);
  });
});

describe("lineDiff oltre il tetto", () => {
  it("due testi da 1 500 righe diverse: confronto grezzo, veloce", () => {
    const a = Array.from({ length: 1500 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 1500 }, (_, i) => `b${i}`).join("\n");
    const t = Date.now();
    const d = lineDiff(a, b);
    expect(Date.now() - t).toBeLessThan(200);
    expect(d).toHaveLength(3000);
    expect(d[0].kind).toBe("removed");
    expect(d[2999].kind).toBe("added");
  });
});

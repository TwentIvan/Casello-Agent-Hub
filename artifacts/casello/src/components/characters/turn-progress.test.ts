import { describe, expect, it } from "vitest";
import type { TurnProgress } from "@workspace/api-client-react";
import { formatElapsed, progressLines } from "./turn-progress";

const START = "2026-11-10T10:00:00.000Z";
const NOW = Date.parse(START) + 42_000;

const progress = (steps: TurnProgress["steps"], omitted = 0): TurnProgress => ({ startedAt: START, steps, omitted });

describe("progressLines", () => {
  it("senza avanzamento: una riga «sta pensando»", () => {
    expect(progressLines(null, "Lucius", NOW)).toEqual({
      lines: [{ text: "Lucius sta pensando…", state: "work" }],
      elapsed: "",
    });
  });

  it("passo in corso: nessuna riga «ragiona»", () => {
    const r = progressLines(
      progress([
        { text: "Legge a.ts", status: "done" },
        { text: 'Cerca "x" nel codice', status: "running" },
      ]),
      "Lucius",
      NOW,
    );
    expect(r.lines).toEqual([
      { text: "Legge a.ts", state: "done" },
      { text: 'Cerca "x" nel codice', state: "work" },
    ]);
    expect(r.elapsed).toBe("42 s");
  });

  it("avanzamento senza passi (turno appena partito): «sta pensando»", () => {
    const r = progressLines(progress([]), "Lucius", NOW);
    expect(r.lines).toEqual([{ text: "Lucius sta pensando…", state: "work" }]);
    expect(r.elapsed).toBe("42 s");
  });

  it("tutti i passi finiti: ultima riga «ragiona»", () => {
    const r = progressLines(progress([{ text: "Legge a.ts", status: "done" }]), "Lucius", NOW);
    expect(r.lines.at(-1)).toEqual({ text: "Lucius ragiona…", state: "work" });
  });

  it("passi omessi: riga in testa", () => {
    const steps: TurnProgress["steps"] = [{ text: "Legge a.ts", status: "done" }];
    expect(progressLines(progress(steps, 3), "Lucius", NOW).lines[0]).toEqual({ text: "… e altri 3 passi", state: "muted" });
    expect(progressLines(progress(steps, 1), "Lucius", NOW).lines[0]).toEqual({ text: "… e un altro passo", state: "muted" });
  });
});

describe("formatElapsed", () => {
  it("formatta secondi e minuti", () => {
    expect(formatElapsed(42_000)).toBe("42 s");
    expect(formatElapsed(65_000)).toBe("1 min 05 s");
    expect(formatElapsed(-5)).toBe("0 s");
  });
});

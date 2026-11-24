import { describe, expect, it } from "vitest";
import { runActivityLines } from "./run-activity";

const NOW = Date.parse("2026-11-24T10:00:10.000Z");

describe("runActivityLines", () => {
  it("senza attività nota: riga generica senza tempo", () => {
    expect(runActivityLines(null, NOW)).toEqual([{ text: "L'agente sta lavorando…", elapsed: "" }]);
  });

  it("nessuna voce in corso: riga generica con il tempo dall'avvio", () => {
    expect(runActivityLines({ startedAt: "2026-11-24T10:00:00.000Z", items: [] }, NOW)).toEqual([
      { text: "L'agente sta lavorando…", elapsed: "10 s" },
    ]);
  });

  it("modello e tool in corso insieme, ognuno col suo tempo", () => {
    const lines = runActivityLines(
      {
        startedAt: "2026-11-24T10:00:00.000Z",
        items: [
          { kind: "model", toolName: null, since: "2026-11-24T10:00:07.000Z" },
          { kind: "tool", toolName: "leggi_rosa", since: "2026-11-24T10:00:08.000Z" },
        ],
      },
      NOW,
    );
    expect(lines).toEqual([
      { text: "Pensa", elapsed: "3 s" },
      { text: "Usa leggi_rosa", elapsed: "2 s" },
    ]);
  });
});

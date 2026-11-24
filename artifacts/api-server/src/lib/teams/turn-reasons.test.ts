import { describe, expect, it } from "vitest";
import { ListTeamTurnsResponseItem } from "@workspace/api-zod";
import { TURN_REASON_TYPES, publicTurnReasons } from "./turn-reasons";

describe("motivi dei turni nella risposta dell'API", () => {
  it("ogni tipo di motivo del capo è nel contratto OpenAPI", () => {
    const contract = ListTeamTurnsResponseItem.shape.reasons.element.shape.type.options as readonly string[];
    for (const type of Object.keys(TURN_REASON_TYPES)) expect(contract).toContain(type);
  });

  it("i motivi noti passano così come sono", () => {
    const reasons = [
      { type: "activation" },
      { type: "request", text: "ciao" },
      { type: "decision", number: 3, outcome: "rejected", note: null },
      { type: "ci_finished", taskCodeId: 2, outcome: "none" },
      { type: "release_failed", workId: 1, message: "conflitto" },
    ];
    expect(publicTurnReasons(1, reasons)).toEqual(reasons);
  });

  it("tipo nuovo, campi non validi e valori non oggetto diventano unknown senza il contenuto", () => {
    expect(
      publicTurnReasons(1, [
        { type: "work_reopened", workId: 4, message: "segreto" },
        { type: "ci_finished", taskCodeId: 2, outcome: "cancelled" },
        "testo",
        { type: "<b>x</b> y" },
        { type: "unknown", originalType: "finto" },
      ]),
    ).toEqual([
      { type: "unknown", originalType: "work_reopened" },
      { type: "unknown", originalType: "ci_finished" },
      { type: "unknown", originalType: "?" },
      { type: "unknown", originalType: "bxby" },
      { type: "unknown", originalType: "unknown" },
    ]);
  });

  it("motivi non in un elenco: nessun motivo", () => {
    expect(publicTurnReasons(1, null)).toEqual([]);
    expect(publicTurnReasons(1, { type: "activation" })).toEqual([]);
  });
});

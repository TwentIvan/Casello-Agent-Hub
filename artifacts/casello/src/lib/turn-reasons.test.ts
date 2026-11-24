import { describe, expect, it } from "vitest";
import type { TeamTurnReason } from "@workspace/api-client-react";
import { reasonText } from "./turn-reasons";

describe("motivi dei turni del capo", () => {
  it("motivi noti", () => {
    expect(reasonText({ type: "activation" })).toBe("Attivazione della squadra");
    expect(reasonText({ type: "request", text: "vai" })).toBe("Richiesta: vai");
    expect(reasonText({ type: "decision", number: 4, outcome: "rejected", note: "no" })).toBe("Voce n. 4 rifiutata: no");
    expect(reasonText({ type: "ci_finished", outcome: "none" })).toBe("Nessuna CI sul branch");
    expect(reasonText({ type: "pr_closed", merged: true })).toBe("PR unita");
    expect(reasonText({ type: "release_failed", message: "conflitto" })).toBe("Porta in produzione non riuscita: conflitto");
  });

  it("motivi non riconosciuti: una riga generica, mai vuota", () => {
    expect(reasonText({ type: "unknown", originalType: "work_reopened" })).toBe("Motivo non riconosciuto (work_reopened)");
    expect(reasonText({ type: "unknown", originalType: "?" })).toBe("Motivo non riconosciuto");
    expect(reasonText({ type: "unknown" })).toBe("Motivo non riconosciuto");
    expect(reasonText({ type: "futuro" } as unknown as TeamTurnReason)).toBe("Motivo non riconosciuto (futuro)");
  });
});

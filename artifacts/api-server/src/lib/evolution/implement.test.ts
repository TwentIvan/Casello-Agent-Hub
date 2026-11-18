import { describe, it, expect } from "vitest";
import { MAX_LEAD_MESSAGE, implementMessage } from "./implement";

describe("messaggio Implementa del ciclo", () => {
  it("elenca le voci del giro con id e issue e dice che il PLAN lo approva il ciclo", () => {
    const text = implementMessage("Mister", [
      { id: 12, title: "Esporta  i report", issueNumber: 40 },
      { id: 13, title: "Filtri", issueNumber: null },
    ], 3);
    expect(text).toContain("«Mister»");
    expect(text).toContain("giro 3 del ciclo");
    expect(text).toContain("queste 2 voci");
    expect(text).toContain("- #12 Esporta i report (issue #40)");
    expect(text).toContain("- #13 Filtri\n");
    expect(text).toContain("leggi_piano_app");
  });

  it("resta entro il limite del messaggio al capo", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, title: "x".repeat(200), issueNumber: i }));
    const text = implementMessage("Mister", items, 1);
    expect(text.length).toBeLessThanOrEqual(MAX_LEAD_MESSAGE);
    expect(text).toMatch(/- e altre \d+ voci/);
  });
});

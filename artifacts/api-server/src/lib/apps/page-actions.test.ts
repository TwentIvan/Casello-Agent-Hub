import { describe, expect, it } from "vitest";
import { findPageAction } from "./page-actions";

describe("findPageAction", () => {
  const actions = [
    { page: "task", label: "Esegui il task", request: "r1" },
    { page: "project", label: "Esegui il task", request: "r2" },
  ];
  it("cerca per pagina ed etichetta, confronto esatto", () => {
    expect(findPageAction(actions, "project", "Esegui il task")?.request).toBe("r2");
    expect(findPageAction(actions, "task", "esegui il task")).toBeNull();
    expect(findPageAction(actions, "proposal", "Esegui il task")).toBeNull();
    expect(findPageAction([], "task", "Esegui il task")).toBeNull();
  });
});

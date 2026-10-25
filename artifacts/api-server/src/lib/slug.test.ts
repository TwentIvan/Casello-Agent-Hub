import { describe, expect, it } from "vitest";
import { slugBase, uniqueSlug } from "./slug";

describe("slug delle app (stessa regola della migrazione)", () => {
  it("minuscolo, non alfanumerici → '-', trattini ai bordi tolti", () => {
    expect(slugBase("Mister App!")).toBe("mister-app");
    expect(slugBase("  The Hub   Up ")).toBe("the-hub-up");
    expect(slugBase("ReMove_2026")).toBe("remove-2026");
    expect(slugBase("Èlite")).toBe("lite");
  });

  it("nome senza caratteri alfanumerici → 'app'", () => {
    expect(slugBase("---")).toBe("app");
    expect(slugBase("")).toBe("app");
  });

  it("collisione: si aggiunge '-<id>' finché lo slug non è libero", async () => {
    const taken = new Set(["mister", "mister-7"]);
    const exists = async (s: string) => taken.has(s);
    expect(await uniqueSlug("Mister", 7, exists)).toBe("mister-7-7");
    expect(await uniqueSlug("Vimini", 7, exists)).toBe("vimini");
  });
});

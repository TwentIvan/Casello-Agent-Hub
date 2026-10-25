import { describe, expect, it } from "vitest";
import { slugBase, uniqueSlug, withSlugRetry } from "./slug";

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

describe("retry sulla collisione dello slug", () => {
  const slugTaken = () => Object.assign(new Error("duplicate key"), { code: "23505", constraint: "apps_slug_unique" });

  it("violazione di apps_slug_unique: si riprova e si restituisce il risultato", async () => {
    let calls = 0;
    const result = await withSlugRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("query fallita", { cause: slugTaken() });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("dopo 3 tentativi l'errore si propaga", async () => {
    let calls = 0;
    await expect(
      withSlugRetry(async () => {
        calls++;
        throw slugTaken();
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(calls).toBe(3);
  });

  it("altri errori (anche altre unique) non si riprovano", async () => {
    let calls = 0;
    const other = Object.assign(new Error("dup"), { code: "23505", constraint: "altro" });
    await expect(
      withSlugRetry(async () => {
        calls++;
        throw other;
      }),
    ).rejects.toBe(other);
    expect(calls).toBe(1);
  });
});

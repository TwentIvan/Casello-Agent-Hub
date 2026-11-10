import { describe, expect, it } from "vitest";
import { PAIR_CODE_KEY, clearPairCode, readPairCode, returnToPath } from "./pair-code";

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("returnToPath", () => {
  it("per la pagina di abbinamento mette il codice da parte e lo toglie dal returnTo", () => {
    const s = fakeStorage();
    const path = returnToPath(new URL("https://c.example/nodes/pair?code=ABCD-1234"), s);
    expect(path).toBe("/nodes/pair");
    expect(path).not.toContain("ABCD");
    expect(s.data.get(PAIR_CODE_KEY)).toBe("ABCD-1234");
  });
  it("le altre pagine restano invariate e non toccano lo storage", () => {
    const s = fakeStorage();
    expect(returnToPath(new URL("https://c.example/runs?x=1"), s)).toBe("/runs?x=1");
    expect(s.data.size).toBe(0);
  });
  it("senza storage non fallisce e non lascia il codice nell'indirizzo", () => {
    expect(returnToPath(new URL("https://c.example/nodes/pair?code=ZZ"), null)).toBe("/nodes/pair");
  });
});

describe("readPairCode / clearPairCode", () => {
  it("legge prima l'indirizzo, poi lo storage", () => {
    const s = fakeStorage();
    s.setItem(PAIR_CODE_KEY, "DA-STORAGE");
    expect(readPairCode("?code=DA-QUERY", s)).toBe("DA-QUERY");
    expect(readPairCode("", s)).toBe("DA-STORAGE");
  });
  it("dopo clearPairCode non resta nulla", () => {
    const s = fakeStorage();
    s.setItem(PAIR_CODE_KEY, "X");
    clearPairCode(s);
    expect(readPairCode("", s)).toBeNull();
  });
});

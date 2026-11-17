import { describe, expect, it } from "vitest";
import { loadOrCreateBrowserKey, type StorageLike } from "./browser-key";

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

describe("loadOrCreateBrowserKey", () => {
  it("chiave di 32 byte base64url, stabile con lo stesso storage", () => {
    const s = memoryStorage();
    const a = loadOrCreateBrowserKey("hubup", s);
    expect(a).toMatch(KEY_RE);
    expect(loadOrCreateBrowserKey("hubup", s)).toBe(a);
    expect(s.data.get("botcave-bug-key:hubup")).toBe(a);
  });
  it("diversa per un'altra App", () => {
    const s = memoryStorage();
    expect(loadOrCreateBrowserKey("hubup", s)).not.toBe(loadOrCreateBrowserKey("mister", s));
  });
  it("valore salvato non valido: se ne genera uno nuovo", () => {
    const s = memoryStorage();
    s.data.set("botcave-bug-key:hubup", "corto");
    const k = loadOrCreateBrowserKey("hubup", s);
    expect(k).toMatch(KEY_RE);
    expect(s.data.get("botcave-bug-key:hubup")).toBe(k);
  });
  it("storage che lancia: chiave valida tenuta in memoria per la sessione", () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("bloccato");
      },
      setItem: () => {
        throw new Error("bloccato");
      },
    };
    const k = loadOrCreateBrowserKey("broken-app", broken);
    expect(k).toMatch(KEY_RE);
    expect(loadOrCreateBrowserKey("broken-app", broken)).toBe(k);
  });
});

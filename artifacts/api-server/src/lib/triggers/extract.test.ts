import { describe, expect, it } from "vitest";
import { compareCursor, extractItems, itemKey, matchesFilter, readPath, type ExtractConfig } from "./extract";

const base: ExtractConfig = { itemsPath: null, idField: "id", versionField: null, cursorField: null, filter: null };

describe("readPath", () => {
  it("legge proprietà proprie, mai indici di array né __proto__", () => {
    const arr = [1];
    expect(readPath({ a: { b: arr } }, ["a", "b"])).toBe(arr);
    expect(readPath({ a: [{ b: 1 }] }, ["a", "0", "b"])).toBeUndefined();
    expect(readPath(JSON.parse('{"__proto__":{"x":1}}'), ["__proto__", "x"])).toBeUndefined();
    expect(readPath({}, ["constructor"])).toBeUndefined();
    expect(readPath({ a: 1 }, ["a", "b"])).toBeUndefined();
  });
});

describe("itemKey", () => {
  it("id 7 e '7' danno la stessa chiave", () => {
    expect(itemKey({ id: 7 }, base)).toBe("7");
    expect(itemKey({ id: "7" }, base)).toBe("7");
  });
  it("aggiunge la versione", () => {
    const cfg = { ...base, versionField: "v" };
    expect(itemKey({ id: 5, v: "2026-11-07" }, cfg)).toBe("5\u001f2026-11-07");
    expect(itemKey({ id: 5 }, cfg)).toBe("5");
    expect(itemKey({ id: 5, v: "x".repeat(100) }, cfg)).toBeNull();
  });
  it("scarta id troppo lungo o mancante", () => {
    expect(itemKey({ id: "x".repeat(201) }, base)).toBeNull();
    expect(itemKey({}, base)).toBeNull();
  });
});

describe("extractItems", () => {
  it("scarta gli elementi senza id", () => {
    const r = extractItems([{ id: 1 }, { nome: "x" }, 3], base);
    expect(r).toMatchObject({ ok: true, skipped: 2 });
    if (r.ok) expect(r.items.map((i) => i.key)).toEqual(["1"]);
  });
  it("filtra con uguaglianza stretta", () => {
    const cfg = { ...base, filter: { field: "status", equals: "completed" } };
    const r = extractItems([{ id: 1, status: "completed" }, { id: 2, status: "open" }], cfg);
    expect(r.ok && r.items.map((i) => i.key)).toEqual(["1"]);
    expect(matchesFilter({ n: "1" }, { field: "n", equals: 1 })).toBe(false);
    expect(matchesFilter({ n: 1 }, { field: "n", equals: 1 })).toBe(true);
    expect(matchesFilter({}, null)).toBe(true);
  });
  it("itemsPath su un oggetto: listNotFound; null su un array: elementi", () => {
    expect(extractItems({ data: { items: {} } }, { ...base, itemsPath: "data.items" })).toEqual({
      ok: false,
      error: "listNotFound",
    });
    expect(extractItems({ data: { items: [{ id: 1 }] } }, { ...base, itemsPath: "data.items" })).toMatchObject({ ok: true });
    expect(extractItems([{ id: 1 }], base)).toMatchObject({ ok: true });
  });
  it("legge al più 500 elementi", () => {
    const list = Array.from({ length: 600 }, (_, i) => ({ id: i }));
    const r = extractItems(list, base);
    expect(r.ok && r.items.length).toBe(500);
  });
  it("porta il cursore", () => {
    const r = extractItems([{ id: 1, at: "2026" }], { ...base, cursorField: "at" });
    expect(r.ok && r.items[0].cursor).toBe("2026");
  });
});

describe("compareCursor", () => {
  it("numeri come numeri, altrimenti stringhe", () => {
    expect(compareCursor(10, 9)).toBeGreaterThan(0);
    expect(compareCursor("10", "9")).toBeLessThan(0);
    expect(compareCursor("2026-01-01", "2026-01-01")).toBe(0);
  });
});

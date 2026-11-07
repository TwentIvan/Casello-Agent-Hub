import { describe, expect, it } from "vitest";
import { parseFieldPath, validateTriggerConfig } from "./config";
import { TRIGGER_MESSAGES } from "./messages";

const poll = { kind: "poll" as const, name: "Nuovi", toolId: 3 };

describe("parseFieldPath", () => {
  it("da 1 a 5 segmenti validi", () => {
    expect(parseFieldPath("data.items")).toEqual(["data", "items"]);
    expect(parseFieldPath("a.b.c.d.e")).toHaveLength(5);
    expect(parseFieldPath("a.b.c.d.e.f")).toBeNull();
    expect(parseFieldPath("a..b")).toBeNull();
    expect(parseFieldPath("a b")).toBeNull();
    expect(parseFieldPath("")).toBeNull();
  });
});

describe("validateTriggerConfig", () => {
  it("normalizza un poll con i predefiniti", () => {
    const r = validateTriggerConfig(poll);
    expect(r).toMatchObject({ ok: true, value: { idField: "id", intervalSeconds: 300, args: {}, filter: null } });
  });
  it("percorso con 6 segmenti", () => {
    expect(validateTriggerConfig({ ...poll, itemsPath: "a.b.c.d.e.f" })).toEqual({ ok: false, error: TRIGGER_MESSAGES.invalidPath });
  });
  it("intervallo 59", () => {
    expect(validateTriggerConfig({ ...poll, intervalSeconds: 59 }).ok).toBe(false);
    expect(validateTriggerConfig({ ...poll, intervalSeconds: 60 }).ok).toBe(true);
  });
  it("cursorParam senza cursorField", () => {
    expect(validateTriggerConfig({ ...poll, cursorParam: "since" })).toEqual({ ok: false, error: TRIGGER_MESSAGES.cursorFieldRequired });
  });
  it("tool su un webhook", () => {
    expect(validateTriggerConfig({ kind: "webhook", name: "W", toolId: 1 })).toEqual({ ok: false, error: TRIGGER_MESSAGES.wrongKindFields });
    expect(validateTriggerConfig({ ...poll, dedupHeader: "X-A" })).toEqual({ ok: false, error: TRIGGER_MESSAGES.wrongKindFields });
  });
  it("nome, istruzioni, args", () => {
    expect(validateTriggerConfig({ ...poll, name: "" }).ok).toBe(false);
    expect(validateTriggerConfig({ ...poll, instructions: "" })).toMatchObject({ ok: true, value: { instructions: null } });
    expect(validateTriggerConfig({ ...poll, name: "a\nb" }).ok).toBe(false);
    expect(validateTriggerConfig({ ...poll, instructions: "  \n " })).toMatchObject({ ok: true, value: { instructions: null } });
    expect(validateTriggerConfig({ ...poll, name: "x".repeat(81) }).ok).toBe(false);
    expect(validateTriggerConfig({ ...poll, instructions: "x".repeat(2001) }).ok).toBe(false);
    expect(validateTriggerConfig({ ...poll, args: { a: "x".repeat(9000) } }).ok).toBe(false);
  });
  it("filtro", () => {
    expect(validateTriggerConfig({ ...poll, filter: { field: "s", equals: "c" } }).ok).toBe(true);
    expect(validateTriggerConfig({ ...poll, filter: { field: "a..b", equals: "c" } }).ok).toBe(false);
  });
  it("webhook valido", () => {
    expect(validateTriggerConfig({ kind: "webhook", name: "W", dedupHeader: "X-GitHub-Delivery" })).toMatchObject({
      ok: true,
      value: { toolId: null, idField: null, intervalSeconds: null },
    });
  });
});

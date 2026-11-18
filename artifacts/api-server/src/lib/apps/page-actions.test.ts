import { describe, expect, it } from "vitest";
import { findPageAction, PAGE_ACTION_MESSAGES, pageActionsHash, validatePageActions } from "./page-actions";

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

describe("validatePageActions", () => {
  const ok = (over: Record<string, unknown> = {}) => ({ page: "task", label: "Esegui", request: "Esegui il task", ...over });
  const err = (actions: unknown) => {
    const r = validatePageActions(actions);
    return r.ok ? null : r.error;
  };

  it("conserva l'ordine e toglie gli spazi", () => {
    const r = validatePageActions([ok({ label: "  B " }), ok({ page: "project", label: "A" }), ok({ label: "C", request: " r " })]);
    expect(r).toEqual({
      ok: true,
      actions: [
        { page: "task", label: "B", request: "Esegui il task" },
        { page: "project", label: "A", request: "Esegui il task" },
        { page: "task", label: "C", request: "r" },
      ],
    });
  });

  it("al massimo 6 azioni per tipo di pagina", () => {
    const seven = Array.from({ length: 7 }, (_, i) => ok({ label: `L${i}` }));
    expect(err(seven)).toBe(PAGE_ACTION_MESSAGES.perPage);
    expect(err(seven.slice(0, 6))).toBeNull();
  });

  it("al massimo 40 azioni per App", () => {
    const many = Array.from({ length: 41 }, (_, i) => ok({ page: `p${Math.floor(i / 6)}`, label: `L${i}` }));
    expect(err(many)).toBe(PAGE_ACTION_MESSAGES.total);
  });

  it("etichetta ripetuta nello stesso tipo di pagina, non tra pagine diverse", () => {
    expect(err([ok(), ok()])).toBe(PAGE_ACTION_MESSAGES.duplicate);
    expect(err([ok(), ok({ page: "project" })])).toBeNull();
  });

  it("page non valido", () => {
    expect(err([ok({ page: "due parole" })])).toBe(PAGE_ACTION_MESSAGES.page);
    expect(err([ok({ page: "" })])).toBe(PAGE_ACTION_MESSAGES.page);
    expect(err([ok({ page: "x".repeat(41) })])).toBe(PAGE_ACTION_MESSAGES.page);
  });

  it("label vuota, con a capo o troppo lunga", () => {
    expect(err([ok({ label: "  " })])).toBe(PAGE_ACTION_MESSAGES.label);
    expect(err([ok({ label: "uno\ndue" })])).toBe(PAGE_ACTION_MESSAGES.label);
    expect(err([ok({ label: "x".repeat(41) })])).toBe(PAGE_ACTION_MESSAGES.label);
  });

  it("request vuota o oltre 1000 caratteri", () => {
    expect(err([ok({ request: "" })])).toBe(PAGE_ACTION_MESSAGES.request);
    expect(err([ok({ request: "x".repeat(1001) })])).toBe(PAGE_ACTION_MESSAGES.request);
    expect(err([ok({ request: "x".repeat(1000) })])).toBeNull();
  });

  it("nessuna credenziale", () => {
    expect(err([ok({ request: `usa sk-${"a".repeat(20)}` })])).toBe(PAGE_ACTION_MESSAGES.credential);
  });
});

describe("pageActionsHash", () => {
  const a = [
    { page: "task", label: "A", request: "r1" },
    { page: "project", label: "B", request: "r2" },
    { page: "task", label: "C", request: "r3" },
  ];
  it("dipende solo dalle azioni di quel tipo di pagina, in ordine", () => {
    const h = pageActionsHash(a, "task");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(pageActionsHash([a[0]!, { page: "other", label: "Z", request: "z" }, a[2]!], "task")).toBe(h);
    expect(pageActionsHash([a[2]!, a[0]!], "task")).not.toBe(h);
    expect(pageActionsHash([{ ...a[0]!, request: "cambiata" }, a[2]!], "task")).not.toBe(h);
  });
});

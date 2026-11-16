import { describe, it, expect } from "vitest";
import type { AnalysisItem } from "@workspace/db";
import { selectRoundItems } from "./select";

let nextId = 1;
function item(over: Partial<AnalysisItem> & { payload?: unknown }): AnalysisItem {
  const id = nextId++;
  return {
    id,
    chapter: "completion",
    ref: `r${id}`,
    position: id,
    status: "pending",
    payload: {},
    ...over,
  } as unknown as AnalysisItem;
}
const comp = (key: string, dependsOn: string[] = [], extra: Partial<AnalysisItem> = {}) =>
  item({ chapter: "completion", payload: { key, phase: 1, dependsOn, title: key }, ...extra });
const evo = (priority: number, extra: Partial<AnalysisItem> = {}) =>
  item({ chapter: "evolution", payload: { priority, area: "a" }, ...extra });

describe("selectRoundItems", () => {
  it("con N=1 sceglie solo la voce da cui le altre dipendono", () => {
    const c2 = comp("c2", ["c1"]);
    const c1 = comp("c1");
    expect(selectRoundItems([c2, c1], 1)).toEqual([c1.id]);
  });

  it("completamento prima, poi evoluzione per priorità", () => {
    const c1 = comp("c1");
    const c2 = comp("c2", ["c1"]);
    const p3 = evo(3);
    const p1 = evo(1);
    expect(selectRoundItems([p3, c2, p1, c1], 3)).toEqual([c1.id, c2.id, p1.id]);
  });

  it("esclude voci non pending e capitoli diversi", () => {
    const a = comp("a", [], { status: "approved" });
    const t = item({ chapter: "tool" as AnalysisItem["chapter"] });
    const ok = evo(2);
    expect(selectRoundItems([a, t, ok], 5)).toEqual([ok.id]);
  });

  it("una dipendenza inesistente conta come soddisfatta", () => {
    const c = comp("c", ["xyz"]);
    expect(selectRoundItems([c], 2)).toEqual([c.id]);
  });
});

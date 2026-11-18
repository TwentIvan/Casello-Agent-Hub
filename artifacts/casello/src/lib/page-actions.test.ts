import { describe, expect, it } from "vitest";
import { groupActions, moveAction } from "./page-actions";

const a = (page: string, label: string) => ({ page, label, request: `r-${label}` });

describe("groupActions", () => {
  it("raggruppa per pagina nell'ordine di prima comparsa", () => {
    const groups = groupActions([a("wi", "1"), a("home", "2"), a("wi", "3")]);
    expect(groups.map((g) => g.page)).toEqual(["wi", "home"]);
    expect(groups[0].actions.map((x) => x.label)).toEqual(["1", "3"]);
  });
});

describe("moveAction", () => {
  const list = [a("wi", "1"), a("home", "2"), a("wi", "3"), a("wi", "4")];
  it("sposta dentro la stessa pagina", () => {
    expect(moveAction(list, "wi", 0, 1).map((x) => x.label)).toEqual(["3", "2", "1", "4"]);
  });
  it("non esce dai limiti", () => {
    expect(moveAction(list, "wi", 0, -1)).toEqual(list);
    expect(moveAction(list, "wi", 2, 1)).toEqual(list);
  });
});

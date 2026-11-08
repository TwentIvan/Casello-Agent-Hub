import { describe, expect, it } from "vitest";
import { dependentsOf } from "./proposal-steps";

const chain = [
  { key: "p1", refs: [] },
  { key: "p2", refs: [{ step: "p1" }] },
  { key: "p3", refs: [{ step: "p2" }] },
  { key: "p4", refs: [] },
];

describe("dependentsOf", () => {
  it("senza esclusioni non salta nulla", () => {
    expect(dependentsOf(chain, new Set())).toEqual(new Set());
  });

  it("escludere il primo salta a catena i passi che lo usano", () => {
    expect(dependentsOf(chain, new Set(["p1"]))).toEqual(new Set(["p2", "p3"]));
  });

  it("escludere un passo intermedio salta solo i successivi", () => {
    expect(dependentsOf(chain, new Set(["p2"]))).toEqual(new Set(["p3"]));
  });

  it("un passo escluso non conta come saltato", () => {
    expect(dependentsOf(chain, new Set(["p1", "p2"]))).toEqual(new Set(["p3"]));
  });
});

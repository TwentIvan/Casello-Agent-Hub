import { afterEach, describe, expect, it } from "vitest";
import {
  RUN_ACTIVITY_MAX_ITEMS,
  applyRunActivity,
  beginRunActivity,
  endRunActivity,
  readRunActivity,
} from "./run-activity";

const T0 = new Date("2026-11-24T10:00:00.000Z");
const T1 = new Date("2026-11-24T10:00:02.000Z");

afterEach(() => {
  endRunActivity(1);
});

describe("attività in corso delle run", () => {
  it("senza voce non c'è attività e gli avvisi si ignorano", () => {
    applyRunActivity(1, { type: "model_start" });
    expect(readRunActivity(1)).toBeNull();
  });

  it("modello e tool con inizio e fine", () => {
    beginRunActivity(1, T0);
    expect(readRunActivity(1)).toEqual({ startedAt: T0.toISOString(), items: [] });
    applyRunActivity(1, { type: "model_start" }, T1);
    expect(readRunActivity(1)?.items).toEqual([{ kind: "model", toolName: null, since: T1.toISOString() }]);
    applyRunActivity(1, { type: "model_end" });
    applyRunActivity(1, { type: "tool_start", callId: "a", toolName: "leggi" }, T1);
    applyRunActivity(1, { type: "tool_start", callId: "b", toolName: "cerca" }, T1);
    expect(readRunActivity(1)?.items.map((i) => i.toolName)).toEqual(["leggi", "cerca"]);
    applyRunActivity(1, { type: "tool_end", callId: "a" });
    expect(readRunActivity(1)?.items.map((i) => i.toolName)).toEqual(["cerca"]);
    endRunActivity(1);
    expect(readRunActivity(1)).toBeNull();
  });

  it("al più RUN_ACTIVITY_MAX_ITEMS voci insieme", () => {
    beginRunActivity(1, T0);
    for (let i = 0; i < RUN_ACTIVITY_MAX_ITEMS + 5; i++) {
      applyRunActivity(1, { type: "tool_start", callId: String(i), toolName: "t" });
    }
    expect(readRunActivity(1)?.items).toHaveLength(RUN_ACTIVITY_MAX_ITEMS);
  });
});

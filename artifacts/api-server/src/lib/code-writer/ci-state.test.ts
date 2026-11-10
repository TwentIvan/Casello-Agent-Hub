import { describe, expect, it } from "vitest";
import { ciState, ciSummary } from "./ci-state";
import type { CiSnapshot } from "./github-git";

const chk = (name: string, status: string, conclusion: string | null) => ({ id: 1, name, status, conclusion, jobId: null });
const snap = (checks: CiSnapshot["checks"] = [], statuses: CiSnapshot["statuses"] = []): CiSnapshot => ({ checks, statuses });

describe("ciState", () => {
  it("pending con un check in corso", () => {
    expect(ciState(snap([chk("a", "in_progress", null)]), 0)).toBe("pending");
    expect(ciState(snap([], [{ context: "x", state: "pending" }]), 0)).toBe("pending");
  });
  it("failure", () => {
    expect(ciState(snap([chk("a", "completed", "timed_out")]), 0)).toBe("failure");
    expect(ciState(snap([], [{ context: "x", state: "error" }]), 0)).toBe("failure");
  });
  it("success con neutral e skipped", () => {
    expect(ciState(snap([chk("a", "completed", "neutral"), chk("b", "completed", "skipped")]), 0)).toBe("success");
  });
  it("none dopo 10 minuti senza nulla", () => {
    expect(ciState(snap(), 600_000)).toBe("none");
    expect(ciState(snap(), 540_000)).toBe("pending");
  });
  it("riepilogo", () => {
    expect(ciSummary(snap([chk("a", "completed", "success")]))).toBe("CI verde");
    expect(ciSummary(snap([chk("lint", "completed", "failure"), chk("t", "completed", "cancelled")], [{ context: "ci/x", state: "failure" }])))
      .toBe("CI non superata: lint, t, ci/x");
    expect(ciSummary(snap([chk("n".repeat(400), "completed", "failure")])).length).toBeLessThanOrEqual(300);
  });
});

import { describe, expect, it } from "vitest";
import { canActivate, roundStatusLed } from "./evolution-consent";

const base = { accepted: true, typedSlug: "the-hub-up", appSlug: "the-hub-up", mergeMode: "staging" as const, directAccepted: false };

describe("canActivate", () => {
  it("serve la casella e lo slug scritto", () => {
    expect(canActivate(base)).toBe(true);
    expect(canActivate({ ...base, accepted: false })).toBe(false);
    expect(canActivate({ ...base, typedSlug: "" })).toBe(false);
    expect(canActivate({ ...base, typedSlug: "altra-app" })).toBe(false);
  });

  it("confronta lo slug dopo trim e senza distinguere le maiuscole", () => {
    expect(canActivate({ ...base, typedSlug: "  The-Hub-Up " })).toBe(true);
  });

  it("con il merge diretto vuole anche la seconda conferma", () => {
    expect(canActivate({ ...base, mergeMode: "direct" })).toBe(false);
    expect(canActivate({ ...base, mergeMode: "direct", directAccepted: true })).toBe(true);
  });
});

describe("roundStatusLed", () => {
  it("associa ogni stato del giro a un LED", () => {
    expect(roundStatusLed("analyzing")).toBe("work");
    expect(roundStatusLed("approving")).toBe("work");
    expect(roundStatusLed("implementing")).toBe("work");
    expect(roundStatusLed("awaiting_release")).toBe("ask");
    expect(roundStatusLed("done")).toBe("ok");
    expect(roundStatusLed("failed")).toBe("ko");
    expect(roundStatusLed("blocked")).toBe("ko");
    expect(roundStatusLed("stopped")).toBe("idle");
    expect(roundStatusLed("rejected")).toBe("idle");
  });
});

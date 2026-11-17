import { describe, expect, it } from "vitest";
import { BUG_STATUS_LABELS, bugStatusLed, visitorBadge } from "./bug-status";

describe("BUG_STATUS_LABELS", () => {
  it("le frasi degli stati sono quelle dell'API", () => {
    expect(BUG_STATUS_LABELS).toEqual({
      received: "In esame",
      triage: "In esame",
      needs_info: "Serve una tua risposta",
      pending_approval: "In attesa di approvazione",
      in_progress: "In lavorazione",
      fixed: "Corretta",
      not_a_bug: "Non è un problema",
      duplicate: "Già segnalata",
      rejected: "Non accolta",
    });
  });
});

describe("bugStatusLed", () => {
  it("LED per stato", () => {
    expect(bugStatusLed("received")).toBe("work");
    expect(bugStatusLed("triage")).toBe("work");
    expect(bugStatusLed("pending_approval")).toBe("work");
    expect(bugStatusLed("in_progress")).toBe("work");
    expect(bugStatusLed("needs_info")).toBe("ask");
    expect(bugStatusLed("fixed")).toBe("ok");
    expect(bugStatusLed("not_a_bug")).toBe("idle");
    expect(bugStatusLed("duplicate")).toBe("idle");
    expect(bugStatusLed("rejected")).toBe("idle");
  });
});

describe("visitorBadge", () => {
  it("conta le segnalazioni non lette", () => {
    expect(visitorBadge([])).toBe(0);
    expect(visitorBadge([{ unseen: true }, { unseen: false }, { unseen: true }])).toBe(2);
  });
});

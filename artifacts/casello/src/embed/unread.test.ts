import { describe, expect, it } from "vitest";
import { IDLE_ACTIVITY, type BotActivity } from "./bot-activity";
import { EMPTY_UNREAD, hasUnread, nextUnread, parseSeen, statusPayload } from "./unread";

const withReply = (bot: "alfred" | "lucius" | "lead", id: number): BotActivity => ({
  ...IDLE_ACTIVITY,
  [bot]: { running: false, lastReplyId: id },
});

describe("nextUnread", () => {
  it("la prima risposta vista è storia, non una novità", () => {
    const s = nextUnread(EMPTY_UNREAD, withReply("alfred", 4), { open: false, tab: "alfred" });
    expect(s.seen.alfred).toBe(4);
    expect(hasUnread(s)).toBe(false);
  });

  it("una risposta nuova a pannello chiuso è non vista finché non si apre la scheda del bot", () => {
    const start = { seen: { lucius: 4 }, unread: {} };
    const closed = nextUnread(start, withReply("lucius", 9), { open: false, tab: "alfred" });
    expect(hasUnread(closed)).toBe(true);
    const otherTab = nextUnread(closed, withReply("lucius", 9), { open: true, tab: "alfred" });
    expect(hasUnread(otherTab)).toBe(true);
    const looking = nextUnread(otherTab, withReply("lucius", 9), { open: true, tab: "lucius" });
    expect(hasUnread(looking)).toBe(false);
  });

  it("una risposta arrivata a pannello aperto non è una novità", () => {
    const s = nextUnread({ seen: { lead: 3 }, unread: {} }, withReply("lead", 5), { open: true, tab: "pending" });
    expect(s.seen.lead).toBe(5);
    expect(hasUnread(s)).toBe(false);
  });
});

describe("parseSeen", () => {
  it("tiene solo interi ≥ 0 dei tre bot", () => {
    expect(parseSeen('{"alfred":3,"lucius":-1,"lead":2.5,"x":1}')).toEqual({ alfred: 3 });
    expect(parseSeen("non json")).toEqual({});
    expect(parseSeen(null)).toEqual({});
  });
});

describe("statusPayload", () => {
  const status = {
    pending: 2,
    bugs: 1,
    actions: [{ label: "a" }, { label: "b" }],
    leadAvailable: true,
    leadWorking: true,
    botNames: { alfred: "Alfred", lucius: "Lucius", lead: "Bea" },
  };
  it("dallo stato del server", () => {
    expect(statusPayload(status, 9, { working: false, unread: true })).toEqual({
      pending: 2,
      bugs: 1,
      working: true,
      unread: true,
      actions: 2,
    });
  });
  it("senza stato: il contatore della coda", () => {
    expect(statusPayload(null, 4, { working: false, unread: false })).toEqual({
      pending: 4,
      bugs: 0,
      working: false,
      unread: false,
      actions: 0,
    });
  });
});

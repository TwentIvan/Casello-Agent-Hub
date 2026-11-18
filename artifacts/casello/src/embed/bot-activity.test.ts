import { describe, expect, it } from "vitest";
import { activityFromQueries, botOfQueryKey, conversationState } from "./bot-activity";

describe("botOfQueryKey", () => {
  it("riconosce le conversazioni dei tre bot e ignora gli elenchi", () => {
    expect(botOfQueryKey(["/api/characters/alfred/thread"])).toBe("alfred");
    expect(botOfQueryKey(["/api/plan-conversations/4"])).toBe("lucius");
    expect(botOfQueryKey(["/api/character-conversations/9"])).toBe("lucius");
    expect(botOfQueryKey(["/api/lead-conversations/3", { app: "hubup" }])).toBe("lead");
    expect(botOfQueryKey(["/api/lead-conversations", { app: "hubup" }])).toBeNull();
    expect(botOfQueryKey(["/api/apps/1/plan-conversations"])).toBeNull();
    expect(botOfQueryKey([42])).toBeNull();
  });
});

describe("conversationState", () => {
  it("Alfred e Lucius: turno e ultima risposta non vuota", () => {
    const data = {
      turnStatus: "running",
      messages: [
        { id: 1, role: "user", content: "ciao" },
        { id: 2, role: "assistant", content: "salve" },
        { id: 3, role: "user", content: "e poi?" },
        { id: 4, role: "assistant", content: "" },
      ],
    };
    expect(conversationState("alfred", data)).toEqual({ running: true, lastReplyId: 2 });
  });

  it("Responsabile: le risposte sono le run concluse", () => {
    const run = (id: number, status: string) => ({ id, status, output: "ok", error: null, items: [] });
    const data = {
      turnStatus: "running",
      messages: [
        { id: 5, content: "a", run: run(10, "succeeded") },
        { id: 6, content: "b", run: run(11, "running") },
      ],
    };
    expect(conversationState("lead", data)).toEqual({ running: true, lastReplyId: 11 });
  });

  it("dati senza messaggi: null", () => {
    expect(conversationState("lucius", undefined)).toBeNull();
    expect(conversationState("lucius", { turnStatus: "idle" })).toBeNull();
  });
});

describe("activityFromQueries", () => {
  it("in corso se una conversazione lo è; ultima risposta = id più alto", () => {
    const a = activityFromQueries([
      { key: ["/api/plan-conversations/1"], data: { turnStatus: "idle", messages: [{ id: 7, role: "assistant", content: "x" }] } },
      { key: ["/api/plan-conversations/2"], data: { turnStatus: "running", messages: [{ id: 3, role: "assistant", content: "y" }] } },
      { key: ["/api/apps"], data: [] },
    ]);
    expect(a.lucius).toEqual({ running: true, lastReplyId: 7 });
    expect(a.alfred).toEqual({ running: false, lastReplyId: null });
  });
});

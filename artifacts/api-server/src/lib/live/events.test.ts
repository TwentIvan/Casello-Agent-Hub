import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunChangeBatcher, publishRunChange, runChangeListenerCount, subscribeRunChanges, type RunChange } from "./events";
import { agentState } from "./activity";

afterEach(() => {
  vi.useRealTimers();
});

describe("publishRunChange", () => {
  it("consegna a tutti gli ascoltatori; uno guasto non ferma gli altri; la funzione restituita li toglie", () => {
    const seen: RunChange[] = [];
    const offBad = subscribeRunChanges(() => {
      throw new Error("guasto");
    });
    const off = subscribeRunChanges((c) => seen.push(c));
    const count = runChangeListenerCount();
    expect(() => publishRunChange(3, 9)).not.toThrow();
    expect(seen).toEqual([{ runId: 3, agentId: 9 }]);
    off();
    offBad();
    expect(runChangeListenerCount()).toBe(count - 2);
    publishRunChange(4, null);
    expect(seen).toHaveLength(1);
  });
});

describe("createRunChangeBatcher", () => {
  it("un messaggio per finestra, una run una volta sola, l'agente noto resta", () => {
    vi.useFakeTimers();
    const batches: RunChange[][] = [];
    const batcher = createRunChangeBatcher((c) => batches.push(c), 300);
    batcher.push({ runId: 1, agentId: 5 });
    batcher.push({ runId: 1, agentId: null });
    batcher.push({ runId: 2, agentId: null });
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(batches).toEqual([[{ runId: 1, agentId: 5 }, { runId: 2, agentId: null }]]);
    batcher.push({ runId: 3, agentId: 1 });
    batcher.stop();
    vi.advanceTimersByTime(1000);
    expect(batches).toHaveLength(1);
  });
});

describe("agentState", () => {
  const zero = { runningRuns: 0, pendingRuns: 0, awaitingClientRuns: 0, activeChildRuns: 0, pendingActions: 0 };
  it("l'utente prima del lavoro, il lavoro prima del fermo", () => {
    expect(agentState(zero)).toBe("idle");
    expect(agentState({ ...zero, pendingRuns: 1 })).toBe("working");
    expect(agentState({ ...zero, activeChildRuns: 1 })).toBe("working");
    expect(agentState({ ...zero, runningRuns: 2, pendingActions: 1 })).toBe("waiting_user");
    expect(agentState({ ...zero, awaitingClientRuns: 1 })).toBe("waiting_user");
  });
});

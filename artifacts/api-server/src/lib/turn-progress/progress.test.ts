import { describe, expect, it } from "vitest";
import {
  PROGRESS_MAX_COUNTED,
  PROGRESS_MAX_STEPS,
  beginTurnProgress,
  endTurnProgress,
  finishStep,
  readTurnProgress,
  startStep,
} from "./progress";

describe("registro dei passi", () => {
  it("begin crea una voce vuota con data ISO", () => {
    beginTurnProgress("plan_chat", 1);
    const v = readTurnProgress("plan_chat", 1);
    expect(v?.steps).toEqual([]);
    expect(v?.omitted).toBe(0);
    expect(new Date(v!.startedAt).toISOString()).toBe(v!.startedAt);
    endTurnProgress("plan_chat", 1);
  });

  it("tiene gli ultimi 8 passi e conta gli omessi", () => {
    beginTurnProgress("team_chat", 2);
    for (let i = 0; i < 10; i++) startStep("team_chat", 2, `passo ${i}`);
    const v = readTurnProgress("team_chat", 2)!;
    expect(v.steps).toHaveLength(PROGRESS_MAX_STEPS);
    expect(v.omitted).toBe(2);
    expect(v.steps[0].text).toBe("passo 2");
    expect(v.steps[7]).toEqual({ text: "passo 9", status: "running" });
    endTurnProgress("team_chat", 2);
  });

  it("finishStep segna done", () => {
    beginTurnProgress("character", 3);
    const id = startStep("character", 3, "a");
    finishStep("character", 3, id);
    expect(readTurnProgress("character", 3)?.steps[0].status).toBe("done");
    finishStep("character", 3, null);
    endTurnProgress("character", 3);
  });

  it("voce inesistente: null e nessuna creazione", () => {
    expect(startStep("plan_chat", 99, "x")).toBeNull();
    expect(readTurnProgress("plan_chat", 99)).toBeNull();
    finishStep("plan_chat", 99, 1);
  });

  it("begin azzera, end toglie, consumer indipendenti", () => {
    beginTurnProgress("plan_chat", 5);
    beginTurnProgress("character", 5);
    startStep("plan_chat", 5, "a");
    expect(readTurnProgress("character", 5)?.steps).toEqual([]);
    beginTurnProgress("plan_chat", 5);
    expect(readTurnProgress("plan_chat", 5)?.steps).toEqual([]);
    endTurnProgress("plan_chat", 5);
    expect(readTurnProgress("plan_chat", 5)).toBeNull();
    expect(readTurnProgress("character", 5)).not.toBeNull();
    endTurnProgress("character", 5);
  });

  it("oltre il tetto di passi contati non registra più", () => {
    beginTurnProgress("plan_chat", 6);
    for (let i = 0; i < PROGRESS_MAX_COUNTED; i++) expect(startStep("plan_chat", 6, "x")).not.toBeNull();
    expect(startStep("plan_chat", 6, "y")).toBeNull();
    expect(readTurnProgress("plan_chat", 6)?.omitted).toBe(PROGRESS_MAX_COUNTED - PROGRESS_MAX_STEPS);
    endTurnProgress("plan_chat", 6);
  });
});

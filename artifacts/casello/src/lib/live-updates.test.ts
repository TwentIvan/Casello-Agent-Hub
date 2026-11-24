import { describe, expect, it } from "vitest";
import {
  LIVE_FALLBACK_MS,
  agentActivityView,
  isRunQueryKey,
  livePollInterval,
  parseRunsEvent,
  queryKeysForRunChanges,
} from "./live-updates";

describe("livePollInterval", () => {
  it("rapido senza flusso, lento con il flusso, spento resta spento", () => {
    expect(livePollInterval(1500, false)).toBe(1500);
    expect(livePollInterval(1500, true)).toBe(LIVE_FALLBACK_MS);
    expect(livePollInterval(60_000, true)).toBe(60_000);
    expect(livePollInterval(false, true)).toBe(false);
  });
});

describe("parseRunsEvent", () => {
  it("tiene solo le run con un id valido; agente non intero → null", () => {
    expect(parseRunsEvent('{"runs":[{"runId":3,"agentId":7},{"runId":4,"agentId":null},{"runId":"x"},{"runId":0},null]}')).toEqual([
      { runId: 3, agentId: 7 },
      { runId: 4, agentId: null },
    ]);
  });
  it("dati non validi → nessuna run, mai eccezioni", () => {
    expect(parseRunsEvent("non json")).toEqual([]);
    expect(parseRunsEvent("null")).toEqual([]);
    expect(parseRunsEvent('{"runs":5}')).toEqual([]);
  });
});

describe("queryKeysForRunChanges", () => {
  it("run e passi di ogni run cambiata, poi elenchi delle run, stato degli agenti e statistiche", () => {
    expect(queryKeysForRunChanges([{ runId: 9, agentId: 1 }])).toEqual([
      ["/api/runs/9"],
      ["/api/runs/9/steps"],
      ["/api/runs"],
      ["/api/agent-activity"],
      ["/api/dashboard/stats"],
    ]);
    expect(queryKeysForRunChanges([])).toEqual([]);
  });
});

describe("isRunQueryKey", () => {
  it("riconosce elenchi, singole run e passi", () => {
    expect(isRunQueryKey(["/api/runs", { limit: 5 }])).toBe(true);
    expect(isRunQueryKey(["/api/runs/3/steps"])).toBe(true);
    expect(isRunQueryKey(["/api/runsx"])).toBe(false);
    expect(isRunQueryKey(["/api/agents"])).toBe(false);
  });
});

describe("agentActivityView", () => {
  const base = { agentId: 1, runningRuns: 0, pendingRuns: 0, awaitingClientRuns: 0, activeChildRuns: 0, pendingActions: 0 };
  it("assente o fermo → idle", () => {
    expect(agentActivityView(undefined)).toEqual({ led: "idle", label: "Fermo", detail: "Nessuna run in corso" });
  });
  it("in lavoro con il dettaglio dei conteggi", () => {
    expect(agentActivityView({ ...base, state: "working", runningRuns: 1, pendingRuns: 2, activeChildRuns: 2 })).toEqual({
      led: "work",
      label: "In lavoro",
      detail: "1 run in corso · 2 run in coda · 2 run figlie aperte",
    });
  });
  it("aspetta l'utente", () => {
    expect(agentActivityView({ ...base, state: "waiting_user", pendingActions: 1 })).toEqual({
      led: "ask",
      label: "Aspetta te",
      detail: "1 voce da confermare",
    });
  });
});

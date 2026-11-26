import { describe, expect, it } from "vitest";
import type { TeamTask, TeamTurn } from "@workspace/api-client-react";
import { TEAM_ACTIVITY_LIMITS, activityLimitNotice, filterActivity, normalizeSearch, searchTerms } from "./team-activity";

const turn = (over: Partial<TeamTurn>): TeamTurn =>
  ({ id: 1, reasons: [], status: "done", error: null, steps: [], createdAt: "2026-11-25T10:00:00Z", ...over }) as TeamTurn;
const task = (over: Partial<TeamTask>): TeamTask =>
  ({
    id: 1,
    planTaskId: "t1",
    roleKey: "dev",
    status: "done",
    outcome: null,
    error: null,
    detail: null,
    nodeName: null,
    createdAt: "2026-11-25T11:00:00Z",
    ...over,
  }) as TeamTask;

const titles = new Map([
  ["t1", "Barra di stato"],
  ["t2", "Ricerca nell'attività"],
]);
const roles = new Map([["dev", "Sviluppatore"]]);
const opts = (kind: "all" | "turns" | "tasks", query: string) => ({ kind, query, taskTitles: titles, roleNames: roles });

describe("attività della squadra", () => {
  it("normalizza la ricerca", () => {
    expect(normalizeSearch("Attività È")).toBe("attivita e");
    expect(searchTerms("  CI   verde ")).toEqual(["ci", "verde"]);
    expect(searchTerms("   ")).toEqual([]);
  });

  it("ordina dal più recente e filtra per tipo", () => {
    const turns = [turn({ id: 1, createdAt: "2026-11-25T09:00:00Z" })];
    const tasks = [task({ id: 2, createdAt: "2026-11-25T12:00:00Z" })];
    expect(filterActivity(turns, tasks, opts("all", "")).map((e) => e.kind)).toEqual(["task", "turn"]);
    expect(filterActivity(turns, tasks, opts("turns", "")).map((e) => e.kind)).toEqual(["turn"]);
    expect(filterActivity(turns, tasks, opts("tasks", "")).map((e) => e.kind)).toEqual(["task"]);
  });

  it("cerca in titolo, ruolo, esito, resoconto, motivi ed errori", () => {
    const turns = [
      turn({ id: 1, reasons: [{ type: "request", text: "Riprova la PR" }] as TeamTurn["reasons"] }),
      turn({ id: 2, error: "credito del provider esaurito" }),
      turn({ id: 3, reasons: [{ type: "ci_finished", outcome: "success" }] as TeamTurn["reasons"] }),
    ];
    const tasks = [
      task({ id: 10, planTaskId: "t1", outcome: "PR #166 unita" }),
      task({ id: 11, planTaskId: "t2", detail: "test della console verdi" }),
    ];
    const ids = (q: string) => filterActivity(turns, tasks, opts("all", q)).map((e) => (e.kind === "turn" ? e.turn.id : e.task.id));
    expect(ids("attivita")).toEqual([11]);
    expect(ids("barra")).toEqual([10]);
    expect(ids("sviluppatore")).toEqual([10, 11]);
    expect(ids("riprova")).toEqual([1]);
    expect(ids("credito")).toEqual([2]);
    expect(ids("ci verde")).toEqual([3]);
    expect(ids("console verdi")).toEqual([11]);
    expect(ids("t2")).toEqual([11]);
    expect(ids("pr unita")).toEqual([10]);
    expect(ids("nulla di simile")).toEqual([]);
    expect(filterActivity(turns, tasks, opts("tasks", "riprova"))).toEqual([]);
  });

  it("avvisa solo quando un limite del server è raggiunto", () => {
    expect(activityLimitNotice(0, 0)).toBeNull();
    expect(activityLimitNotice(TEAM_ACTIVITY_LIMITS.turns - 1, TEAM_ACTIVITY_LIMITS.tasks - 1)).toBeNull();
    expect(activityLimitNotice(50, 3)).toContain("gli ultimi 50 turni del capo:");
    expect(activityLimitNotice(1, 200)).toContain("gli ultimi 200 compiti:");
    expect(activityLimitNotice(50, 200)).toContain("gli ultimi 50 turni del capo e gli ultimi 200 compiti");
  });
});

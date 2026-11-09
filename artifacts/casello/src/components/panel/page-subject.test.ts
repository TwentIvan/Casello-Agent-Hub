import { describe, expect, it } from "vitest";
import { handoffTarget, pageFromPath } from "./page-subject";

describe("pageFromPath", () => {
  it("mappa le pagine note", () => {
    expect(pageFromPath("/")).toEqual({ page: "dashboard" });
    expect(pageFromPath("/teams")).toEqual({ page: "teams" });
    expect(pageFromPath("/teams/7")).toEqual({ page: "team", id: "7" });
    expect(pageFromPath("/runs/3")).toEqual({ page: "run", id: "3" });
    expect(pageFromPath("/pending-actions")).toEqual({ page: "pending_actions" });
    expect(pageFromPath("/agents")).toEqual({ page: "console" });
  });
});

describe("handoffTarget", () => {
  const page = { page: "dashboard" } as const;
  it("verso Alfred", () => {
    expect(handoffTarget({ to: "alfred", question: "q" }, page)).toEqual({ target: { kind: "alfred", page }, draft: "q" });
  });
  it("plan con id valido e non valido", () => {
    expect(handoffTarget({ to: "lucius", subjectType: "plan", subjectId: "4", question: "q" }, page)).toEqual({
      target: { kind: "plan", appId: 4 },
      draft: "q",
    });
    expect(handoffTarget({ to: "lucius", subjectType: "plan", subjectId: "abc", question: "q" }, page)).toBeNull();
  });
  it("team", () => {
    expect(handoffTarget({ to: "lucius", subjectType: "team", subjectId: "2", question: "q" }, page)?.target).toEqual({
      kind: "team",
      instanceId: 2,
      closed: false,
    });
  });
  it("agent", () => {
    expect(handoffTarget({ to: "lucius", subjectType: "agent", subjectId: "9", question: "q" }, page)?.target).toEqual({
      kind: "character",
      subjectType: "agent",
      subjectId: "9",
      title: "",
    });
  });
  it("destinatario sconosciuto o payload nullo", () => {
    expect(handoffTarget({ to: "bob" }, page)).toBeNull();
    expect(handoffTarget(null, page)).toBeNull();
  });
});

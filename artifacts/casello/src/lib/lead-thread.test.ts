import { describe, expect, it } from "vitest";
import type { TeamEvent, TeamTurn } from "@workspace/api-client-react";
import { buildLeadThread, leadThreadLimitNotice } from "./lead-thread";

const turn = (over: Partial<TeamTurn>): TeamTurn =>
  ({
    id: 1,
    reasons: [],
    status: "done",
    error: null,
    steps: [],
    createdAt: "2026-11-25T10:00:00Z",
    startedAt: "2026-11-25T10:00:01Z",
    finishedAt: "2026-11-25T10:01:00Z",
    ...over,
  }) as TeamTurn;
const reply = (over: Partial<TeamEvent>): TeamEvent =>
  ({
    id: 1,
    instanceId: 1,
    type: "risposta_capo",
    taskId: null,
    turnId: 1,
    bulletin: "Fatto",
    detail: null,
    readAt: null,
    createdAt: "2026-11-25T10:01:00Z",
    ...over,
  }) as TeamEvent;
const userReq = (text: string) => ({ type: "request" as const, text, source: "user" as const });

describe("thread con il capo", () => {
  it("mette in fila messaggi dell'utente e risposte, dal più vecchio", () => {
    const turns = [
      turn({ id: 2, createdAt: "2026-11-25T11:00:00Z", reasons: [userReq("E poi?")] }),
      turn({ id: 1, reasons: [userReq("Ciao"), userReq("Ancora")] }),
    ];
    const events = [
      reply({ id: 5, turnId: 2, bulletin: "Poi basta", createdAt: "2026-11-25T11:01:00Z" }),
      reply({ id: 4, turnId: 1, bulletin: "corto…", detail: "Risposta intera", readAt: "2026-11-25T12:00:00Z" }),
    ];
    const thread = buildLeadThread(turns, events);
    expect(thread.map((i) => [i.kind, "text" in i ? i.text : null])).toEqual([
      ["user", "Ciao"],
      ["user", "Ancora"],
      ["lead", "Risposta intera"],
      ["user", "E poi?"],
      ["lead", "Poi basta"],
    ]);
    expect(thread[2]).toMatchObject({ unread: false });
    expect(thread[4]).toMatchObject({ unread: true });
  });

  it("esclude i testi di Botcave, quelli senza origine e gli altri motivi", () => {
    const turns = [
      turn({
        reasons: [
          { type: "request", text: "Riprendi il lavoro", source: "system" },
          { type: "request", text: "vecchio" },
          { type: "task_finished", taskId: 3 },
        ],
      }),
    ];
    expect(buildLeadThread(turns, [])).toEqual([]);
  });

  it("segnala i turni in attesa, falliti o senza risposta", () => {
    const turns = [
      turn({ id: 1, status: "done", reasons: [userReq("a")] }),
      turn({ id: 2, status: "failed", error: "tetto raggiunto", createdAt: "2026-11-25T11:00:00Z", reasons: [userReq("b")] }),
      turn({ id: 3, status: "queued", startedAt: null, finishedAt: null, createdAt: "2026-11-25T12:00:00Z", reasons: [userReq("c")] }),
    ];
    const kinds = buildLeadThread(turns, []).map((i) => i.kind);
    expect(kinds).toEqual(["user", "no_reply", "user", "failed", "user", "pending"]);
    expect(buildLeadThread(turns, []).find((i) => i.kind === "failed")).toMatchObject({ error: "tetto raggiunto" });
  });

  it("tiene le risposte senza turno noto al loro posto nel tempo e ignora gli altri eventi", () => {
    const turns = [turn({ id: 1, createdAt: "2026-11-25T12:00:00Z", reasons: [userReq("dopo")] })];
    const events = [
      reply({ id: 7, turnId: null, bulletin: "vecchia", createdAt: "2026-11-25T09:00:00Z" }),
      reply({ id: 8, turnId: 99, bulletin: "turno oltre il limite", createdAt: "2026-11-25T10:00:00Z" }),
      reply({ id: 9, type: "compito_finito", turnId: null, bulletin: "non c'entra" }),
    ];
    expect(buildLeadThread(turns, events).map((i) => ("text" in i ? i.text : i.kind))).toEqual([
      "vecchia",
      "turno oltre il limite",
      "dopo",
      "no_reply",
    ]);
  });

  it("avvisa solo al limite dei turni", () => {
    expect(leadThreadLimitNotice(49)).toBeNull();
    expect(leadThreadLimitNotice(50)).toContain("ultimi 50 turni");
  });
});

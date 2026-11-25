import { describe, expect, it } from "vitest";
import type { TeamTask, TeamTurn } from "@workspace/api-client-react";
import { TEAM_TABS, TEAM_TAB_LABELS, currentWork, pollingLabel } from "./team-status-bar";

const turn = (status: TeamTurn["status"]) => ({ status }) as TeamTurn;
const task = (planTaskId: string, status: TeamTask["status"]) => ({ planTaskId, status }) as TeamTask;
const titles = new Map([["t1", "Barra di stato"]]);

describe("barra di stato della squadra", () => {
  it("niente in corso", () => {
    expect(currentWork(undefined, undefined, titles)).toEqual({ led: "idle", text: "Nessun turno o compito in corso" });
    expect(currentWork([turn("done")], [task("t1", "done"), task("t2", "failed")], titles).led).toBe("idle");
  });

  it("turno del capo prima dei compiti, con il titolo del compito", () => {
    expect(currentWork([turn("queued"), turn("running")], [task("t1", "running")], titles)).toEqual({
      led: "work",
      text: "Turno del capo in corso · Compito t1 «Barra di stato» in corso",
    });
    expect(currentWork([turn("queued")], [], titles).text).toBe("Turno del capo in coda");
  });

  it("più compiti dello stesso stato si contano; il nodo si dice", () => {
    expect(
      currentWork([], [task("t1", "running"), task("t2", "running"), task("t3", "waiting_node")], titles).text,
    ).toBe("2 compiti in corso · Compito t3 in attesa del nodo");
  });

  it("indicatore dell'aggiornamento", () => {
    expect(pollingLabel("active", true, 5000)).toEqual({ led: "work", text: "Si aggiorna ogni 5 s" });
    expect(pollingLabel("active", false, 5000).led).toBe("idle");
    expect(pollingLabel("closed", true, 5000).text).toBe("Squadra chiusa: nessun aggiornamento");
  });

  it("cinque schede con l'etichetta", () => {
    expect(TEAM_TABS.map((t) => TEAM_TAB_LABELS[t])).toEqual(["Panoramica", "Piano", "Attività", "Messaggi", "Impostazioni"]);
  });
});

import type { TeamInstanceStatus, TeamTask, TeamTurn } from "@workspace/api-client-react";

/** Schede della pagina squadra, nell'ordine in cui compaiono. */
export const TEAM_TABS = ["overview", "plan", "activity", "messages", "settings"] as const;
export type TeamTab = (typeof TEAM_TABS)[number];

export const TEAM_TAB_LABELS: Record<TeamTab, string> = {
  overview: "Panoramica",
  plan: "Piano",
  activity: "Attività",
  messages: "Messaggi",
  settings: "Impostazioni",
};

type Led = "idle" | "work" | "ask";

/** Turno o compito in corso, come riga della barra di stato. */
export interface CurrentWork {
  led: Led;
  text: string;
}

const TASK_LIVE = new Set<TeamTask["status"]>(["queued", "running", "waiting_node"]);

function taskLabel(task: TeamTask, titles: ReadonlyMap<string, string>): string {
  const title = titles.get(task.planTaskId);
  return title ? `${task.planTaskId} «${title}»` : task.planTaskId;
}

/**
 * Cosa sta facendo la squadra ora: prima il turno del capo (in corso, poi in coda), poi i compiti (in corso, in coda,
 * in attesa del nodo). Con più compiti dello stesso stato si dà il numero; senza nulla in corso la riga lo dice.
 */
export function currentWork(
  turns: readonly TeamTurn[] | undefined,
  tasks: readonly TeamTask[] | undefined,
  titles: ReadonlyMap<string, string>,
): CurrentWork {
  const parts: string[] = [];
  let led: Led = "idle";
  const turnList = turns ?? [];
  if (turnList.some((t) => t.status === "running")) {
    parts.push("Turno del capo in corso");
    led = "work";
  } else if (turnList.some((t) => t.status === "queued")) {
    parts.push("Turno del capo in coda");
    led = "work";
  }
  const live = (tasks ?? []).filter((t) => TASK_LIVE.has(t.status));
  const groups: [TeamTask["status"], string, string][] = [
    ["running", "in corso", "compiti in corso"],
    ["queued", "in coda", "compiti in coda"],
    ["waiting_node", "in attesa del nodo", "compiti in attesa del nodo"],
  ];
  for (const [status, one, many] of groups) {
    const group = live.filter((t) => t.status === status);
    if (group.length === 1) parts.push(`Compito ${taskLabel(group[0], titles)} ${one}`);
    else if (group.length > 1) parts.push(`${group.length} ${many}`);
    if (group.length > 0) led = "work";
  }
  if (parts.length === 0) return { led: "idle", text: "Nessun turno o compito in corso" };
  return { led, text: parts.join(" · ") };
}

/** Indicatore dell'aggiornamento automatico della pagina. */
export function pollingLabel(status: TeamInstanceStatus, polling: boolean, pollMs: number): CurrentWork {
  if (status === "closed") return { led: "idle", text: "Squadra chiusa: nessun aggiornamento" };
  if (polling) return { led: "work", text: `Si aggiorna ogni ${Math.round(pollMs / 1000)} s` };
  return { led: "idle", text: "Aggiornamento automatico in pausa" };
}

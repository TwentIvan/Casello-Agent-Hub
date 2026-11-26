import type { TeamTask, TeamTurn } from "@workspace/api-client-react";
import { reasonText } from "./turn-reasons";

/**
 * Quante voci dell'attività arrivano dal server: gli ultimi 50 turni del capo e gli ultimi 200 compiti. Copia dei limiti
 * `MAX_TURNS` e `MAX_TASKS` di `artifacts/api-server/src/routes/team-instances.ts` (`GET …/turns` e `GET …/tasks`): se
 * cambiano lì, vanno cambiati qui. Le voci più vecchie non si raggiungono dalla console.
 */
export const TEAM_ACTIVITY_LIMITS = { turns: 50, tasks: 200 } as const;

export type ActivityKind = "all" | "turns" | "tasks";

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  all: "Turni e compiti",
  turns: "Solo turni del capo",
  tasks: "Solo compiti",
};

export type ActivityEntry = { kind: "turn"; at: string; turn: TeamTurn } | { kind: "task"; at: string; task: TeamTask };

/** Minuscole e senza accenti: «attività» si trova anche scrivendo «attivita». */
export function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Parole della ricerca: tutte devono comparire nella voce (in qualunque campo). */
export function searchTerms(query: string): string[] {
  return normalizeSearch(query).split(/\s+/).filter(Boolean);
}

/** Testo in cui si cerca: tipo, titolo, ruolo, motivi, esito, errore e resoconto. */
export function entrySearchText(e: ActivityEntry, taskTitles: ReadonlyMap<string, string>, roleNames: ReadonlyMap<string, string>): string {
  const parts: (string | null | undefined)[] =
    e.kind === "turn"
      ? ["turno del capo", ...e.turn.reasons.map(reasonText), e.turn.error]
      : [
          "compito",
          e.task.planTaskId,
          taskTitles.get(e.task.planTaskId),
          e.task.roleKey,
          roleNames.get(e.task.roleKey),
          e.task.nodeName,
          e.task.outcome,
          e.task.error,
          e.task.detail,
        ];
  return normalizeSearch(parts.filter((p): p is string => !!p).join("\n"));
}

/** Voci dal più recente, filtrate per tipo e per le parole della ricerca. */
export function filterActivity(
  turns: readonly TeamTurn[],
  tasks: readonly TeamTask[],
  opts: { kind: ActivityKind; query: string; taskTitles: ReadonlyMap<string, string>; roleNames: ReadonlyMap<string, string> },
): ActivityEntry[] {
  const terms = searchTerms(opts.query);
  const entries: ActivityEntry[] = [
    ...(opts.kind === "tasks" ? [] : turns.map((turn): ActivityEntry => ({ kind: "turn", at: turn.createdAt, turn }))),
    ...(opts.kind === "turns" ? [] : tasks.map((task): ActivityEntry => ({ kind: "task", at: task.createdAt, task }))),
  ];
  const found =
    terms.length === 0
      ? entries
      : entries.filter((e) => {
          const text = entrySearchText(e, opts.taskTitles, opts.roleNames);
          return terms.every((t) => text.includes(t));
        });
  return found.sort((a, b) => b.at.localeCompare(a.at));
}

/** Avviso quando l'elenco ha raggiunto un limite del server: le voci più vecchie non sono nella pagina. */
export function activityLimitNotice(turnCount: number, taskCount: number): string | null {
  const turnsFull = turnCount >= TEAM_ACTIVITY_LIMITS.turns;
  const tasksFull = taskCount >= TEAM_ACTIVITY_LIMITS.tasks;
  if (!turnsFull && !tasksFull) return null;
  const what = [
    turnsFull ? `gli ultimi ${TEAM_ACTIVITY_LIMITS.turns} turni del capo` : null,
    tasksFull ? `gli ultimi ${TEAM_ACTIVITY_LIMITS.tasks} compiti` : null,
  ]
    .filter(Boolean)
    .join(" e ");
  return `Qui ci sono solo ${what}: quelli più vecchi non si raggiungono dalla console e la ricerca non li trova.`;
}

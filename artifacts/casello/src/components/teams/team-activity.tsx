import { useCallback, useEffect, useState } from "react";
import { Bot, ListChecks } from "lucide-react";
import {
  type TeamInstance,
  type TeamTask,
  type TeamTurn,
  type TeamTurnReason,
  getGetTeamTaskQueryKey,
  getListTeamTasksQueryKey,
  getListTeamTurnsQueryKey,
  useGetTeamTask,
  useListTeamTasks,
  useListTeamTurns,
} from "@workspace/api-client-react";
import { StepList } from "@/components/runs/run-steps";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatCost, formatDuration, formatRelative } from "@/lib/format";
import { TaskStatusBadge, TurnStatusBadge } from "./team-work-status";

export const TEAM_POLL_MS = 5000;

function isTurnLive(t: TeamTurn): boolean {
  return t.status === "queued" || t.status === "running";
}
function isTaskLive(t: TeamTask): boolean {
  return t.status === "queued" || t.status === "running";
}

/** Dopo l'ultimo turno o compito attivo si continua a interrogare per due giri: il turno del capo che segue un compito
 * finito (o una decisione, un messaggio, l'attivazione) viene accodato un attimo dopo. */
export const TEAM_GRACE_MS = 2 * TEAM_POLL_MS;

/**
 * Turni e compiti della squadra. `live` è vero finché un turno o un compito è in coda o in corso; `polling` anche per
 * `TEAM_GRACE_MS` dopo la fine e dopo ogni `kick` (azioni dell'utente che accodano un turno): intanto la pagina si
 * aggiorna ogni 5 secondi.
 */
export function useTeamWork(teamId: number) {
  const [graceUntil, setGraceUntil] = useState(0);
  const [inGrace, setInGrace] = useState(false);
  // `live` del render precedente: dipende dai dati di queste stesse query
  const [wasLive, setWasLive] = useState(false);
  const poll = wasLive || inGrace ? TEAM_POLL_MS : false;
  const turns = useListTeamTurns(teamId, { query: { queryKey: getListTeamTurnsQueryKey(teamId), refetchInterval: poll } });
  const tasks = useListTeamTasks(teamId, { query: { queryKey: getListTeamTasksQueryKey(teamId), refetchInterval: poll } });
  const live = (turns.data ?? []).some(isTurnLive) || (tasks.data ?? []).some(isTaskLive);

  // Fine del lavoro: parte il periodo di grazia
  useEffect(() => {
    if (wasLive && !live) setGraceUntil(Date.now() + TEAM_GRACE_MS);
    setWasLive(live);
  }, [live, wasLive]);

  // Periodo di grazia attivo fino alla scadenza
  useEffect(() => {
    const left = graceUntil - Date.now();
    if (left <= 0) {
      setInGrace(false);
      return;
    }
    setInGrace(true);
    const timer = setTimeout(() => setInGrace(false), left);
    return () => clearTimeout(timer);
  }, [graceUntil]);

  const kick = useCallback(() => setGraceUntil(Date.now() + TEAM_GRACE_MS), []);
  return { turns, tasks, live, polling: live || inGrace, kick };
}

export type TeamWorkState = ReturnType<typeof useTeamWork>;

function reasonText(r: TeamTurnReason): string {
  switch (r.type) {
    case "request":
      return r.text ? `Richiesta: ${r.text}` : "Richiesta";
    case "task_finished":
      return r.taskId != null ? `Compito finito (esecuzione #${r.taskId})` : "Compito finito";
    case "decision": {
      const outcome = r.outcome === "approved" ? "approvata" : r.outcome === "rejected" ? "rifiutata" : "decisa";
      return `Voce n. ${r.number ?? "?"} ${outcome}${r.note ? `: ${r.note}` : ""}`;
    }
    case "activation":
      return "Attivazione della squadra";
    case "restart":
      return "Ripresa dopo un riavvio";
  }
}

const formatTime = (value: string) => new Date(value).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

function tokens(x: { promptTokens: number | null; completionTokens: number | null }): number {
  return (x.promptTokens ?? 0) + (x.completionTokens ?? 0);
}

function elapsed(startedAt: string | null, finishedAt: string | null): string | null {
  if (!startedAt || !finishedAt) return null;
  return formatDuration(new Date(finishedAt).getTime() - new Date(startedAt).getTime());
}

/** Costo, durata e momento di un turno o di un compito. */
function Meta({ item }: { item: TeamTurn | TeamTask }) {
  const cost = formatCost(item.costUsd, tokens(item));
  const duration = elapsed(item.startedAt, item.finishedAt);
  return (
    <span className="ml-auto flex flex-wrap items-center gap-x-2 text-xs tabular-nums text-muted-foreground">
      {cost && <span>{cost}</span>}
      {duration && <span>{duration}</span>}
      <span>{formatRelative(item.createdAt)}</span>
    </span>
  );
}

function TurnEntry({ turn }: { turn: TeamTurn }) {
  return (
    <li className="space-y-1.5 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Bot className="size-4 text-muted-foreground" />
        <span className="font-medium">Turno del capo</span>
        <TurnStatusBadge status={turn.status} />
        <Meta item={turn} />
      </div>
      {turn.reasons.length > 0 && (
        <ul className="space-y-0.5 pl-6 text-xs text-muted-foreground">
          {turn.reasons.map((r, i) => (
            <li key={i} className="line-clamp-3 break-words">
              {reasonText(r)}
            </li>
          ))}
        </ul>
      )}
      {turn.error && <p className="pl-6 text-xs text-destructive break-words">{turn.error}</p>}
      {turn.steps.length > 0 && (
        <details className="pl-6 text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">Passi ({turn.steps.length})</summary>
          <StepList steps={turn.steps} />
        </details>
      )}
    </li>
  );
}

/** Passi di un'esecuzione: caricati solo quando si apre il dettaglio. */
function TaskSteps({ teamId, task }: { teamId: number; task: TeamTask }) {
  const detail = useGetTeamTask(teamId, task.id, {
    query: { queryKey: getGetTeamTaskQueryKey(teamId, task.id), refetchInterval: isTaskLive(task) ? TEAM_POLL_MS : false },
  });
  if (detail.isError && !detail.data) {
    return <p className="text-xs text-destructive">Impossibile caricare i passi: {apiErrorMessage(detail.error)}</p>;
  }
  if (!detail.data) return <Skeleton className="h-10 w-full" />;
  const steps = detail.data.steps ?? [];
  if (steps.length === 0) return <p className="text-xs text-muted-foreground">Nessun passo.</p>;
  return <StepList steps={steps} />;
}

function TaskEntry({ team, task, title }: { team: TeamInstance; task: TeamTask; title: string | null }) {
  const [open, setOpen] = useState(false);
  const role = team.roles.find((r) => r.key === task.roleKey)?.name ?? task.roleKey;
  return (
    <li className="space-y-1.5 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <ListChecks className="size-4 text-muted-foreground" />
        <span className="font-mono text-xs text-muted-foreground">{task.planTaskId}</span>
        <span className="min-w-0 break-words font-medium">{title ?? "Compito"}</span>
        <span className="text-muted-foreground">· {role}</span>
        <TaskStatusBadge status={task.status} />
        <Meta item={task} />
      </div>
      {(task.nodeName || task.sessionId || task.leaseExpiresAt) && (
        <p className="pl-6 text-xs text-muted-foreground break-words">
          Nodo: <span className="font-medium text-foreground">{task.nodeName ?? "non più registrato"}</span>
          {task.leaseExpiresAt && task.status === "running" && ` · lease fino alle ${formatTime(task.leaseExpiresAt)}`}
          {task.sessionId && (
            <>
              {" "}· sessione <span className="font-mono">{task.sessionId}</span>
            </>
          )}
        </p>
      )}
      {task.outcome && <p className="pl-6 text-sm break-words">{task.outcome}</p>}
      {task.error && <p className="pl-6 text-xs text-destructive break-words">{task.error}</p>}
      {task.detail && (
        <details className="pl-6 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Resoconto</summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{task.detail}</p>
        </details>
      )}
      <details className="pl-6 text-sm" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer text-xs text-muted-foreground">Passi</summary>
        {open && <TaskSteps teamId={team.id} task={task} />}
      </details>
    </li>
  );
}

type Entry = { kind: "turn"; at: string; turn: TeamTurn } | { kind: "task"; at: string; task: TeamTask };

/** «Attività»: turni del capo e compiti dei ruoli, dal più recente, con i passi espandibili. */
export function TeamActivity({
  team,
  work,
  taskTitles,
}: {
  team: TeamInstance;
  work: TeamWorkState;
  /** Titoli dei compiti del PLAN per id. */
  taskTitles: Map<string, string>;
}) {
  const { turns, tasks } = work;
  const entries: Entry[] = [
    ...(turns.data ?? []).map((turn): Entry => ({ kind: "turn", at: turn.createdAt, turn })),
    ...(tasks.data ?? []).map((task): Entry => ({ kind: "task", at: task.createdAt, task })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const error = turns.error ?? tasks.error;
  const loading = !turns.data || !tasks.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Attività</CardTitle>
        <CardDescription>
          Turni del capo e compiti dei ruoli, dal più recente.
          {work.polling && " Aggiornamento automatico in corso."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && loading ? (
          <p className="text-sm text-destructive">Impossibile caricare l'attività: {apiErrorMessage(error)}</p>
        ) : loading ? (
          <Skeleton className="h-16 w-full" />
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {team.status === "draft" ? "Nessuna attività: la squadra non è ancora attiva." : "Nessuna attività per ora."}
          </p>
        ) : (
          <ol className="divide-y">
            {entries.map((e) =>
              e.kind === "turn" ? (
                <TurnEntry key={`turn-${e.turn.id}`} turn={e.turn} />
              ) : (
                <TaskEntry
                  key={`task-${e.task.id}`}
                  team={team}
                  task={e.task}
                  title={taskTitles.get(e.task.planTaskId) ?? null}
                />
              ),
            )}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

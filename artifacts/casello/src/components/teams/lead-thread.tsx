import { useEffect, useMemo, useRef } from "react";
import { getListTeamEventsQueryKey, useListTeamEvents } from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { TeamWorkState } from "@/components/teams/team-activity";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";
import { type ThreadItem, buildLeadThread, leadThreadLimitNotice } from "@/lib/lead-thread";
import { cn } from "@/lib/utils";

function Bubble({ who, at, mine, children }: { who: string; at: string; mine: boolean; children: React.ReactNode }) {
  return (
    <li className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[85%] min-w-0 rounded-md border p-3", mine ? "border-brand bg-brand/8" : "bg-surface-1")}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{who}</span>
          <span className="ml-auto">{formatRelative(at)}</span>
        </div>
        <div className="mt-1 whitespace-pre-wrap break-words text-sm">{children}</div>
      </div>
    </li>
  );
}

function ThreadEntry({ item }: { item: ThreadItem }) {
  switch (item.kind) {
    case "user":
      return (
        <Bubble who="Tu" at={item.at} mine>
          {item.text}
        </Bubble>
      );
    case "lead":
      return (
        <Bubble who="Capo" at={item.at} mine={false}>
          {item.text}
          {item.unread && <Led state="ask" label="Non letto nel bollettino" className="mt-2 text-caption" />}
        </Bubble>
      );
    case "pending":
      return (
        <li>
          <Led state="work" label={item.status === "running" ? "Il capo sta rispondendo…" : "Il capo legge nel prossimo turno."} />
        </li>
      );
    case "failed":
      return (
        <li>
          <Led state="ko" label={`Turno del capo non riuscito${item.error ? `: ${item.error}` : ""}`} title={item.error ?? undefined} />
        </li>
      );
    case "no_reply":
      return (
        <li>
          <Led state="idle" label="Il capo ha lavorato senza una risposta scritta: vedi l'attività." />
        </li>
      );
  }
}

/** Thread con il capo: messaggi dell'utente e risposte del capo, dal più vecchio; si aggiorna con il polling della squadra. */
export function LeadThread({ teamId, work, poll }: { teamId: number; work: TeamWorkState; poll: number | false }) {
  const events = useListTeamEvents(teamId, { query: { queryKey: getListTeamEventsQueryKey(teamId), refetchInterval: poll } });
  const turns = work.turns;
  const thread = useMemo(() => buildLeadThread(turns.data ?? [], events.data ?? []), [turns.data, events.data]);
  const notice = leadThreadLimitNotice(turns.data?.length ?? 0);
  const listRef = useRef<HTMLOListElement>(null);
  const lastKey = thread.at(-1)?.key;
  useEffect(() => {
    // all'apertura e a ogni voce nuova si vede l'ultima
    const list = listRef.current;
    if (lastKey && list) list.scrollTop = list.scrollHeight;
  }, [lastKey]);

  const loading = turns.isLoading || events.isLoading;
  const error = (turns.isError && !turns.data ? turns.error : null) ?? (events.isError && !events.data ? events.error : null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Conversazione con il capo</CardTitle>
        <CardDescription>I tuoi messaggi al capo e le sue risposte, dal più vecchio.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : error ? (
          <p className="text-sm text-destructive">Impossibile caricare la conversazione: {apiErrorMessage(error)}</p>
        ) : thread.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessun messaggio: scrivi al capo qui sotto.</p>
        ) : (
          <ol
            ref={listRef}
            className="max-h-[60vh] space-y-3 overflow-y-auto pr-1" aria-label="Conversazione con il capo">
            {thread.map((item) => (
              <ThreadEntry key={item.key} item={item} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

import { useQueryClient } from "@tanstack/react-query";
import {
  type TeamEventType,
  getListTeamEventsQueryKey,
  getListUnreadTeamEventsQueryKey,
  useListTeamEvents,
  useMarkTeamEventsRead,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

const EVENT_LABELS: Record<TeamEventType, string> = {
  piano_proposto: "Piano proposto",
  compito_finito: "Compito finito",
  bloccato: "Bloccato",
  decisione_richiesta: "Decisione richiesta",
  azione_manuale_richiesta: "Azione manuale richiesta",
  lavoro_finito: "Lavoro finito",
  interrotto: "Interrotto",
};

/** Bollettino della squadra: eventi dal più recente, i non letti evidenziati. */
export function TeamBulletin({ teamId, poll }: { teamId: number; poll: number | false }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const events = useListTeamEvents(teamId, {
    query: { queryKey: getListTeamEventsQueryKey(teamId), refetchInterval: poll },
  });
  const unread = (events.data ?? []).filter((e) => e.readAt === null).map((e) => e.id);
  const markRead = useMarkTeamEventsRead({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListTeamEventsQueryKey(teamId) });
        void queryClient.invalidateQueries({ queryKey: getListUnreadTeamEventsQueryKey() });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Eventi non segnati", description: apiErrorMessage(error) }),
    },
  });

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Bollettino</CardTitle>
          <CardDescription>Le notizie della squadra, dalla più recente.</CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={unread.length === 0 || markRead.isPending}
          onClick={() => markRead.mutate({ data: { ids: unread.slice(0, 500) } })}
        >
          {markRead.isPending ? "Aggiornamento…" : `Segna come letti${unread.length > 0 ? ` (${unread.length})` : ""}`}
        </Button>
      </CardHeader>
      <CardContent>
        {events.isError && !events.data ? (
          <p className="text-sm text-destructive">Impossibile caricare il bollettino: {apiErrorMessage(events.error)}</p>
        ) : !events.data ? (
          <Skeleton className="h-16 w-full" />
        ) : events.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessuna notizia per ora.</p>
        ) : (
          <ul className="space-y-2">
            {events.data.map((e) => {
              const isUnread = e.readAt === null;
              return (
                <li
                  key={e.id}
                  className={cn(
                    "rounded-md border p-3",
                    isUnread && "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{EVENT_LABELS[e.type]}</Badge>
                    {isUnread && <span className="font-medium text-amber-800 dark:text-amber-300">Non letto</span>}
                    <span className="ml-auto">{formatRelative(e.createdAt)}</span>
                  </div>
                  <p className="mt-1.5 break-words text-sm">{e.bulletin}</p>
                  {e.detail && (
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer text-muted-foreground">Dettaglio</summary>
                      <p className="mt-1 whitespace-pre-wrap break-words">{e.detail}</p>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

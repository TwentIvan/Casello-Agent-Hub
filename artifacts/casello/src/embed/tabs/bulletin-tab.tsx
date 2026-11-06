// Scheda «Bollettino» del pannello: eventi non letti delle squadre dell'utente, con la voce della console
// (TeamEventItem), «Segna come letti» e il collegamento alla scheda squadra nella console (nuova scheda).
import { useQueryClient } from "@tanstack/react-query";
import {
  getListTeamInstancesQueryKey,
  getListUnreadTeamEventsQueryKey,
  useListTeamInstances,
  useListUnreadTeamEvents,
  useMarkTeamEventsRead,
} from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { TeamEventItem } from "@/components/teams/team-bulletin";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { consoleUrl } from "../panel-helpers";

const PARAMS = { unread: true } as const;
const REFRESH_MS = 30_000;

export function BulletinTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const events = useListUnreadTeamEvents(PARAMS, {
    query: { queryKey: getListUnreadTeamEventsQueryKey(PARAMS), refetchInterval: REFRESH_MS },
  });
  // Nomi delle squadre per le voci (l'evento porta solo l'id)
  const teams = useListTeamInstances(undefined, { query: { queryKey: getListTeamInstancesQueryKey() } });
  const teamName = new Map((teams.data ?? []).map((t) => [t.id, t.name]));
  const unread = (events.data ?? []).filter((e) => e.readAt === null).map((e) => e.id);
  const markRead = useMarkTeamEventsRead({
    mutation: {
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: getListUnreadTeamEventsQueryKey() }),
      onError: (error) =>
        toast({ variant: "destructive", title: "Eventi non segnati", description: apiErrorMessage(error) }),
    },
  });
  const origin = window.location.origin;

  return (
    <div className="min-w-0 space-y-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-body-sm text-ink-muted">Le notizie non lette delle tue squadre.</p>
        <Button
          variant="outline"
          size="sm"
          disabled={unread.length === 0 || markRead.isPending}
          onClick={() => markRead.mutate({ data: { ids: unread.slice(0, 500) } })}
        >
          {markRead.isPending ? "Aggiornamento…" : `Segna come letti${unread.length > 0 ? ` (${unread.length})` : ""}`}
        </Button>
      </div>
      {events.isError && !events.data ? (
        <p className="text-body-sm text-danger">Impossibile caricare il bollettino: {apiErrorMessage(events.error)}</p>
      ) : !events.data ? (
        <Skeleton className="h-16 w-full" />
      ) : events.data.length === 0 ? (
        <div className="flex justify-center p-6">
          <Led state="ok" label="Nessuna notizia da leggere" />
        </div>
      ) : (
        <ul className="space-y-2">
          {events.data.map((e) => (
            <TeamEventItem
              key={e.id}
              event={e}
              footer={
                <a
                  href={consoleUrl(origin, `/teams/${e.instanceId}`)}
                  target="_blank"
                  rel="noopener"
                  className="mt-1.5 inline-block max-w-full truncate text-caption text-accent-text underline underline-offset-2"
                >
                  {teamName.get(e.instanceId) ?? `Squadra ${e.instanceId}`} · Apri in Botcave
                </a>
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

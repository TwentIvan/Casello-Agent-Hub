// Osserva la cache di React Query: le conversazioni dei bot che le schede hanno letto dicono chi sta rispondendo e qual è
// l'ultima risposta. Una conversazione in corso la cui scheda non è più montata (nessun osservatore) si rilegge a ogni
// giro dello stato, così il LED si spegne e la risposta arriva anche a scheda cambiata o pannello chiuso.
import { useCallback, useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { activityFromQueries, botOfQueryKey, conversationState, sameActivity, type BotActivity } from "./bot-activity";
import { hasUnread, nextUnread, parseSeen, sameUnread, type SeenReplies, type UnreadState } from "./unread";

function readActivity(client: QueryClient): BotActivity {
  return activityFromQueries(client.getQueryCache().getAll().map((q) => ({ key: q.queryKey, data: q.state.data })));
}

export function useBotActivity(): { activity: BotActivity; refreshUnwatched(): void } {
  const client = useQueryClient();
  const [activity, setActivity] = useState<BotActivity>(() => readActivity(client));

  useEffect(() => {
    const update = () => {
      const next = readActivity(client);
      setActivity((prev) => (sameActivity(prev, next) ? prev : next));
    };
    update();
    return client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" || event.type === "removed" || event.type === "added") update();
    });
  }, [client]);

  const refreshUnwatched = useCallback(() => {
    void client.refetchQueries({
      type: "inactive",
      predicate: (q) => {
        const bot = botOfQueryKey(q.queryKey);
        return bot !== null && conversationState(bot, q.state.data)?.running === true;
      },
    });
  }, [client]);

  return { activity, refreshUnwatched };
}

const SEEN_KEY = "botcave-embed-seen-replies";

function loadSeen(): SeenReplies {
  try {
    return parseSeen(window.sessionStorage.getItem(SEEN_KEY));
  } catch {
    return {};
  }
}

function saveSeen(seen: SeenReplies): void {
  try {
    window.sessionStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Storage non disponibile (finestra privata, dati bloccati): resta in memoria
  }
}

/** C'è una risposta di un bot arrivata a pannello chiuso e non ancora vista nella scheda di quel bot. */
export function useUnreadReplies(activity: BotActivity, open: boolean, tab: string): boolean {
  const [state, setState] = useState<UnreadState>(() => ({ seen: loadSeen(), unread: {} }));
  useEffect(() => {
    setState((prev) => {
      const next = nextUnread(prev, activity, { open, tab });
      return sameUnread(prev, next) ? prev : next;
    });
  }, [activity, open, tab]);
  useEffect(() => saveSeen(state.seen), [state.seen]);
  return hasUnread(state);
}

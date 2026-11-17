// Stato del pannello incorporato per l'amministratore collegato: GET /api/embed/status (contatori, azioni della pagina,
// Responsabile, nomi dei bot), letto ogni 30 s a pannello chiuso, ogni 5 s aperto e subito a ogni cambio di contesto.
// Senza contesto (la pagina ospite non ha chiamato `setContext`) lo stato non si legge, perché il tipo di pagina è
// obbligatorio e il server lo registra tra quelli visti: il contatore resta quello delle voci da confermare.
import { useEffect, useRef } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  getGetEmbedStatusQueryKey,
  getListPendingActionsQueryKey,
  useGetEmbedStatus,
  useListPendingActions,
  type EmbedStatus,
} from "@workspace/api-client-react";
import type { FromFrame, HostContextMsg } from "./protocol";
import { badgeIntervalMs, nextBadge } from "./panel-helpers";

const PENDING_PARAMS = { status: "pending" } as const;

export function useStatus(open: boolean, context: HostContextMsg | null, post: (m: FromFrame) => void): EmbedStatus | null {
  const interval = badgeIntervalMs(open);
  const page = context?.page ?? "";
  const params = { page };
  const status = useGetEmbedStatus(params, {
    query: {
      // Anche l'id nella chiave: ogni cambio di contesto si legge subito, senza perdere i dati mostrati nel frattempo
      queryKey: [...getGetEmbedStatusQueryKey(params), context?.id ?? ""],
      enabled: context !== null,
      refetchInterval: interval,
      // A pannello chiuso il documento può risultare in background: lo stato si aggiorna comunque
      refetchIntervalInBackground: true,
      placeholderData: keepPreviousData,
    },
  });
  const pendingList = useListPendingActions(PENDING_PARAMS, {
    query: {
      queryKey: getListPendingActionsQueryKey(PENDING_PARAMS),
      enabled: context === null,
      refetchInterval: interval,
      refetchIntervalInBackground: true,
    },
  });
  const data = context !== null ? (status.data ?? null) : null;
  const pending = data ? data.pending : pendingList.data?.actions.length;

  const last = useRef<number | null>(null);
  useEffect(() => {
    if (pending === undefined) return;
    const next = nextBadge(last.current, pending);
    if (next === null) return;
    last.current = next;
    post({ botcave: 1, type: "badge", payload: { pending: next } });
  }, [pending, post]);

  return data;
}

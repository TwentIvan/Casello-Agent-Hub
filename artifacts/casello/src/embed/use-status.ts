// Stato del pannello incorporato per l'amministratore collegato: GET /api/embed/status (contatori, azioni della pagina,
// Responsabile, nomi dei bot), letto ogni 30 s a pannello chiuso, ogni 5 s aperto e subito a ogni cambio di contesto.
// Senza contesto (la pagina ospite non ha chiamato `setContext`) lo stato non si legge, perché il tipo di pagina è
// obbligatorio e il server lo registra tra quelli visti: il contatore resta quello delle voci da confermare.
// Il messaggio `status` per il pulsante lo compone il pannello (servono anche bot al lavoro e risposte non viste) e lo
// manda `usePostStatus`, solo quando cambia.
import { useEffect, useRef } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  getGetEmbedStatusQueryKey,
  getListPendingActionsQueryKey,
  useGetEmbedStatus,
  useListPendingActions,
  type EmbedStatus,
} from "@workspace/api-client-react";
import type { FromFrame, HostContextMsg, StatusPayload } from "./protocol";
import { badgeIntervalMs } from "./panel-helpers";

const PENDING_PARAMS = { status: "pending" } as const;

export interface StatusRead {
  /** Stato del server per la pagina, null senza contesto o finché non è letto. */
  data: EmbedStatus | null;
  /** Voci da confermare: dallo stato, o dall'elenco della coda senza contesto; undefined finché non lette. */
  pending: number | undefined;
}

export function useStatus(open: boolean, context: HostContextMsg | null): StatusRead {
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

  return { data, pending };
}

/** Manda `status` alla pagina ospite quando cambia; null = non ancora noto, non si manda nulla. */
export function usePostStatus(payload: StatusPayload | null, post: (m: FromFrame) => void): void {
  const last = useRef<string | null>(null);
  const key = payload ? JSON.stringify(payload) : null;
  useEffect(() => {
    if (key === null || key === last.current || !payload) return;
    last.current = key;
    post({ botcave: 1, type: "status", payload });
    // `payload` cambia con `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, post]);
}

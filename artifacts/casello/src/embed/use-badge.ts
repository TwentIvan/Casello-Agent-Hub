// Contatore delle voci da confermare sul pulsante della pagina ospite (messaggio `badge`).
// Il caricatore nasconde il pannello con display:none, che non cambia `visibilityState` dell'iframe: per sapere se il
// pannello è mostrato si osserva anche l'intersezione del documento con la finestra (IntersectionObserver, a pannello
// nascosto non interseca). Senza IntersectionObserver il pannello si considera mostrato finché il documento è visibile.
import { useEffect, useRef, useState } from "react";
import { getListPendingActionsQueryKey, useListPendingActions } from "@workspace/api-client-react";
import type { FromFrame } from "./protocol";
import { badgeIntervalMs, isPanelOpen, nextBadge } from "./panel-helpers";
import type { HostOpenRequest } from "./use-host";

const PENDING_PARAMS = { status: "pending" } as const;

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/** Pannello mostrato all'utente: documento visibile e iframe non nascosto dal caricatore. */
export function usePanelOpen(openRequest: HostOpenRequest | null): boolean {
  const [visible, setVisible] = useState(isDocumentVisible);
  const [shown, setShown] = useState(true);

  useEffect(() => {
    const onChange = () => setVisible(isDocumentVisible());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !document.body) return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setShown(last.isIntersecting);
    });
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  // `open` dalla pagina ospite: il pannello è appena stato mostrato
  useEffect(() => {
    if (openRequest) setShown(true);
  }, [openRequest]);

  return isPanelOpen({ visible, shown });
}

/** Legge le voci `pending` (5 s a pannello aperto, 30 s altrimenti) e manda `badge` solo quando il numero cambia. */
export function useBadge(open: boolean, post: (m: FromFrame) => void): void {
  const interval = badgeIntervalMs(open);
  const list = useListPendingActions(PENDING_PARAMS, {
    query: {
      queryKey: getListPendingActionsQueryKey(PENDING_PARAMS),
      refetchInterval: interval,
      // A pannello chiuso il documento può risultare in background: il contatore si aggiorna comunque, ogni 30 s
      refetchIntervalInBackground: true,
    },
  });
  const last = useRef<number | null>(null);
  const count = list.data?.actions.length;

  useEffect(() => {
    if (count === undefined) return;
    const next = nextBadge(last.current, count);
    if (next === null) return;
    last.current = next;
    post({ botcave: 1, type: "badge", payload: { pending: next } });
  }, [count, post]);
}

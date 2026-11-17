// Pannello mostrato e contatore del visitatore sul pulsante della pagina ospite (le sue segnalazioni con novità non
// ancora viste). Lo stato dell'amministratore collegato è in use-status.ts.
// Il caricatore nasconde il pannello con display:none, che non cambia `visibilityState` dell'iframe: per sapere se il
// pannello è mostrato si osserva anche l'intersezione del documento con la finestra (IntersectionObserver, a pannello
// nascosto non interseca). Senza IntersectionObserver il pannello si considera mostrato finché il documento è visibile.
import { useEffect, useRef, useState } from "react";
import type { FromFrame } from "./protocol";
import { isPanelOpen, nextBadge, VISITOR_BADGE_CLOSED_MS, VISITOR_BADGE_OPEN_MS } from "./panel-helpers";
import { visitorBadge } from "@/lib/bug-status";
import { useVisitorBugList } from "./bugs/visitor-bugs";
import type { HostOpenRequest } from "./use-host";

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

/**
 * Contatore del visitatore: segnalazioni con novità non viste, lette ogni 10 s a pannello aperto e ogni 60 s chiuso,
 * ma a pannello chiuso solo se il visitatore ha almeno una segnalazione.
 */
export function useVisitorBadge(open: boolean, post: (m: FromFrame) => void): void {
  const [hasReports, setHasReports] = useState(false);
  const list = useVisitorBugList(open ? VISITOR_BADGE_OPEN_MS : hasReports ? VISITOR_BADGE_CLOSED_MS : false);
  const last = useRef<number | null>(null);
  const data = list.data;

  useEffect(() => {
    if (!data) return;
    setHasReports(data.length > 0);
    const next = nextBadge(last.current, visitorBadge(data));
    if (next === null) return;
    last.current = next;
    post({ botcave: 1, type: "badge", payload: { pending: next } });
  }, [data, post]);
}

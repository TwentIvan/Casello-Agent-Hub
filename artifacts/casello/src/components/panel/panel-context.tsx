// Stato e ambiente del pannello unico di Botcave, uguale nella console e nell'iframe delle app ospiti.
// L'ambiente (`PanelEnv`) è l'unica differenza tra le due superfici: collegamenti, contesto di Alfred, chiusura.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { useLocation } from "wouter";
import type { ChatTarget, PageContext } from "../characters/adapters";
import { targetKey } from "../characters/targets";
import { alfredPageContext } from "@/embed/panel-helpers";
import type { HostContextMsg } from "@/embed/protocol";
import { pageFromPath } from "./page-subject";
import { INITIAL_PANEL_STATE, panelReducer, type PanelAction, type PanelState } from "./panel-state";
import type { PanelTab } from "./tabs";

export type PanelEnv =
  | { surface: "console" }
  | { surface: "embed"; appSlug: string; appName: string | null; hostContext: HostContextMsg | null; onClose(): void };

export interface PanelApi {
  state: PanelState;
  env: PanelEnv;
  openPanel(tab?: PanelTab, opts?: { clearOverride?: boolean }): void;
  closePanel(): void;
  selectTab(tab: PanelTab): void;
  handoff(target: ChatTarget, draft: string): void;
  clearOverride(): void;
  /** Contesto di Alfred: pageFromPath(location) nella console, alfredPageContext(appSlug, hostContext) nell'embed. */
  alfredPage: PageContext;
  hasUnsavedChanges(): boolean;
}

interface PanelContextValue extends PanelApi {
  dispatch(action: PanelAction): void;
  /** Controllo delle modifiche non salvate della pagina: in un ref, non nel riduttore. */
  unsavedRef: { current: (() => boolean) | null };
}

const PanelContext = createContext<PanelContextValue | null>(null);

/** Nella console la pagina corrente; su ogni cambio di indirizzo il pannello si chiude (azione `navigate`). */
function useConsoleLocation(enabled: boolean, dispatch: (action: PanelAction) => void): string {
  const [location] = useLocation();
  const last = useRef(location);
  useEffect(() => {
    // Solo su un cambio vero: al primo montaggio `last` è già uguale
    if (!enabled || last.current === location) return;
    last.current = location;
    dispatch({ type: "navigate" });
  }, [enabled, location, dispatch]);
  return location;
}

export function PanelProvider({ env, children }: { env: PanelEnv; children: ReactNode }) {
  const [state, dispatch] = useReducer(panelReducer, INITIAL_PANEL_STATE);
  const unsavedRef = useRef<(() => boolean) | null>(null);
  const location = useConsoleLocation(env.surface === "console", dispatch);

  const onClose = env.surface === "embed" ? env.onClose : null;
  const appSlug = env.surface === "embed" ? env.appSlug : null;
  const hostContext = env.surface === "embed" ? env.hostContext : null;

  const alfredPage = useMemo<PageContext>(
    () => (appSlug !== null ? alfredPageContext(appSlug, hostContext) : pageFromPath(location)),
    [appSlug, hostContext, location],
  );

  const openPanel = useCallback((tab?: PanelTab, opts?: { clearOverride?: boolean }) => dispatch({ type: "open", tab, clearOverride: opts?.clearOverride }), []);
  const closePanel = useCallback(() => {
    dispatch({ type: "close" });
    // Nell'iframe chiudere vuol dire nascondere l'iframe: lo fa il caricatore della pagina ospite
    onClose?.();
  }, [onClose]);
  const selectTab = useCallback((tab: PanelTab) => dispatch({ type: "selectTab", tab }), []);
  const handoff = useCallback((target: ChatTarget, draft: string) => dispatch({ type: "handoff", target, draft }), []);
  const clearOverride = useCallback(() => dispatch({ type: "clearOverride" }), []);
  const hasUnsavedChanges = useCallback(() => unsavedRef.current?.() ?? false, []);

  const value = useMemo<PanelContextValue>(
    () => ({
      state,
      env,
      openPanel,
      closePanel,
      selectTab,
      handoff,
      clearOverride,
      alfredPage,
      hasUnsavedChanges,
      dispatch,
      unsavedRef,
    }),
    [state, env, openPanel, closePanel, selectTab, handoff, clearOverride, alfredPage, hasUnsavedChanges],
  );

  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

function usePanelContext(): PanelContextValue {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error("PanelProvider mancante");
  return ctx;
}

export function usePanel(): PanelApi {
  const { dispatch: _dispatch, unsavedRef: _unsaved, ...api } = usePanelContext();
  return api;
}

/** Chiave dell'argomento per le dipendenze: `targetKey` più i campi mostrati (titolo, squadra chiusa) che possono arrivare dopo. */
function subjectDepKey(lucius: ChatTarget | null): string | null {
  if (!lucius) return null;
  const extra = lucius.kind === "character" ? lucius.title : lucius.kind === "team" ? String(lucius.closed) : "";
  return `${targetKey(lucius)}|${extra}`;
}

/**
 * La pagina dichiara l'argomento di Lucius e il controllo delle modifiche non salvate; entrambi si tolgono quando la
 * pagina si smonta. Si confronta la chiave dell'argomento, non l'oggetto: le pagine possono passare letterali.
 */
export function usePanelSubject({ lucius, hasUnsavedChanges }: { lucius: ChatTarget | null; hasUnsavedChanges?: () => boolean }): void {
  const { dispatch, unsavedRef } = usePanelContext();
  const key = subjectDepKey(lucius);
  const luciusRef = useRef(lucius);
  luciusRef.current = lucius;
  // Il controllo può essere una funzione nuova a ogni render: si aggiorna il ref a ogni render, senza dispatch
  const mine = useRef<(() => boolean) | null>(null);
  mine.current = hasUnsavedChanges ?? null;
  unsavedRef.current = mine.current;
  useLayoutEffect(() => {
    unsavedRef.current = mine.current;
  });

  useEffect(() => {
    dispatch({ type: "setPageSubject", lucius: luciusRef.current });
  }, [key, dispatch]);

  useEffect(
    () => () => {
      dispatch({ type: "setPageSubject", lucius: null });
      // La pagina successiva può aver già messo il suo controllo durante il render: si toglie solo il proprio
      if (unsavedRef.current === mine.current) unsavedRef.current = null;
    },
    [dispatch, unsavedRef],
  );
}

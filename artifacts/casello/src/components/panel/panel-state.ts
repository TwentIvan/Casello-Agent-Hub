import type { ChatTarget } from "../characters/adapters";
import { targetKey } from "../characters/targets";
import type { PanelTab } from "./tabs";

// Stato puro del pannello unico: nessun React, così si prova con Vitest in ambiente node.

export interface PanelState {
  open: boolean;
  tab: PanelTab;
  /** Bozza da mettere nel campo della scheda `draftTab`; `nonce` cresce a ogni passaggio di consegne. */
  draft: { tab: PanelTab; text: string } | null;
  nonce: number;
  /** Argomento di Lucius dato dalla pagina corrente. */
  pageLucius: ChatTarget | null;
  /** Argomento di Lucius scelto da un passaggio di consegne, al posto di quello della pagina. */
  override: ChatTarget | null;
}

export type PanelAction =
  | { type: "open"; tab?: PanelTab }
  | { type: "close" }
  | { type: "selectTab"; tab: PanelTab }
  | { type: "handoff"; target: ChatTarget; draft: string }
  | { type: "setPageSubject"; lucius: ChatTarget | null }
  | { type: "navigate" }
  | { type: "clearOverride" };

export const INITIAL_PANEL_STATE: PanelState = {
  open: false,
  tab: "alfred",
  draft: null,
  nonce: 0,
  pageLucius: null,
  override: null,
};

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "open":
      return { ...state, open: true, tab: action.tab ?? state.tab };
    case "close":
      return { ...state, open: false };
    case "selectTab":
      return { ...state, tab: action.tab };
    case "handoff": {
      if (action.target.kind === "alfred") {
        return { ...state, open: true, tab: "alfred", draft: { tab: "alfred", text: action.draft }, nonce: state.nonce + 1 };
      }
      // Sull'argomento della pagina non serve sostituire nulla
      const samePage = state.pageLucius !== null && targetKey(state.pageLucius) === targetKey(action.target);
      return {
        ...state,
        open: true,
        tab: "lucius",
        draft: { tab: "lucius", text: action.draft },
        nonce: state.nonce + 1,
        override: samePage ? null : action.target,
      };
    }
    case "setPageSubject":
      return { ...state, pageLucius: action.lucius };
    case "navigate":
      return { ...state, open: false, override: null, draft: null };
    case "clearOverride":
      return { ...state, override: null };
  }
}

/** Argomento di Lucius in uso: la sostituzione, altrimenti quello della pagina. */
export function luciusTarget(state: PanelState): ChatTarget | null {
  return state.override ?? state.pageLucius;
}

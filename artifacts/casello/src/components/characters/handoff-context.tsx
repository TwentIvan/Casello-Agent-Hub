import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import type { ChatTarget } from "./adapters";
import { handoffTarget, pageFromPath } from "../panel/page-subject";
import { CharacterSheet } from "./character-sheet";

// Un solo pannello laterale per tutta la console: lo aprono i pulsanti «Chiedi a…» e i passaggi di consegne tra Alfred e
// Lucius (scheda `handoff`: l'altro personaggio si apre con la domanda già scritta nel campo, non inviata).

interface PanelState {
  target: ChatTarget;
  draft: string;
  /** Cresce a ogni apertura: il pannello si rimonta anche sullo stesso bersaglio (nuova bozza). */
  nonce: number;
  hasUnsavedChanges?: () => boolean;
}

interface HandoffContextValue {
  open(target: ChatTarget, draft: string): void;
  show(target: ChatTarget, hasUnsavedChanges?: () => boolean): void;
}

const HandoffContext = createContext<HandoffContextValue | null>(null);

export function HandoffProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PanelState | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [location] = useLocation();

  // Cambiando pagina il pannello si chiude: l'argomento e l'avviso delle modifiche non salvate erano della pagina lasciata
  const lastLocation = useRef(location);
  useEffect(() => {
    if (lastLocation.current !== location) {
      setIsOpen(false);
      // Il controllo era della pagina lasciata: i passaggi successivi non devono dare avvisi spuri
      setState((prev) => (prev && prev.hasUnsavedChanges ? { ...prev, hasUnsavedChanges: undefined } : prev));
    }
    lastLocation.current = location;
  }, [location]);

  const open = useCallback((target: ChatTarget, draft: string) => {
    // Il controllo delle modifiche non salvate resta quello della pagina sotto il pannello
    setState((prev) => ({ target, draft, nonce: (prev?.nonce ?? 0) + 1, hasUnsavedChanges: prev?.hasUnsavedChanges }));
    setIsOpen(true);
  }, []);
  const show = useCallback((target: ChatTarget, hasUnsavedChanges?: () => boolean) => {
    setState((prev) => ({ target, draft: "", nonce: (prev?.nonce ?? 0) + 1, hasUnsavedChanges }));
    setIsOpen(true);
  }, []);
  const value = useMemo(() => ({ open, show }), [open, show]);

  return (
    <HandoffContext.Provider value={value}>
      {children}
      {state && (
        <CharacterSheet
          key={state.nonce}
          open={isOpen}
          onOpenChange={setIsOpen}
          target={state.target}
          draft={state.draft}
          hasUnsavedChanges={state.hasUnsavedChanges}
        />
      )}
    </HandoffContext.Provider>
  );
}

function usePanelContext(): HandoffContextValue {
  const ctx = useContext(HandoffContext);
  if (!ctx) throw new Error("HandoffProvider mancante");
  return ctx;
}

/** Apre l'altro personaggio sul bersaglio con la domanda nel campo, senza inviarla. */
export function useHandoff(): { open(target: ChatTarget, draft: string): void } {
  const { open } = usePanelContext();
  return { open };
}

/** Apre il pannello di un personaggio (usato da `CharacterButton`). */
export function useCharacterPanel(): { show(target: ChatTarget, hasUnsavedChanges?: () => boolean): void } {
  const { show } = usePanelContext();
  return { show };
}

// Riesportati per chi li importava da qui
export { handoffTarget, pageFromPath };

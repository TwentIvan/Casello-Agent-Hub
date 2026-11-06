import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { SUBJECT_LABELS, type ChatTarget, type PageContext } from "./adapters";
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

/** Pagina della console per il contesto di Alfred, dall'indirizzo (pagine della mappa; le altre: `console`). */
export function pageFromPath(path: string): PageContext {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/") return { page: "dashboard" };
  const m = /^\/(teams|runs)\/([^/]+)$/.exec(clean);
  if (m) return { page: m[1] === "teams" ? "team" : "run", id: decodeURIComponent(m[2]).slice(0, 100) };
  if (clean === "/teams") return { page: "teams" };
  if (clean === "/runs") return { page: "runs" };
  if (clean === "/pending-actions") return { page: "pending_actions" };
  return { page: "console" };
}

const LUCIUS_SUBJECTS = new Set(Object.keys(SUBJECT_LABELS));

function positiveInt(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Bersaglio di una scheda `handoff` (`{to, subjectType, subjectId, question}`); null se il payload non è valido. */
export function handoffTarget(payload: Record<string, unknown> | null, currentPage: PageContext): { target: ChatTarget; draft: string } | null {
  if (!payload) return null;
  const question = typeof payload.question === "string" ? payload.question : "";
  const subjectType = typeof payload.subjectType === "string" ? payload.subjectType : "";
  const subjectId = typeof payload.subjectId === "string" ? payload.subjectId : null;
  if (payload.to === "alfred") return { target: { kind: "alfred", page: currentPage }, draft: question };
  if (payload.to !== "lucius") return null;
  if (subjectType === "plan") {
    const appId = positiveInt(subjectId);
    return appId === null ? null : { target: { kind: "plan", appId }, draft: question };
  }
  if (subjectType === "team") {
    const instanceId = positiveInt(subjectId);
    // Lo stato della squadra lo rilegge l'adattatore: chiusa → sola lettura
    return instanceId === null ? null : { target: { kind: "team", instanceId, closed: false }, draft: question };
  }
  if (LUCIUS_SUBJECTS.has(subjectType)) {
    return {
      target: { kind: "character", subjectType: subjectType as keyof typeof SUBJECT_LABELS, subjectId, title: "" },
      draft: question,
    };
  }
  return null;
}

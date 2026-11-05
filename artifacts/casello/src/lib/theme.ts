import { useCallback, useState } from "react";

// Tema della console: «system» segue il sistema; «light» e «dark» lo forzano con data-theme su <html>.
// La scelta resta nel browser (localStorage); index.html la applica prima del primo disegno.

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "botcave-theme";

function readChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function applyChoice(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    if (choice === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Archivio non disponibile (navigazione privata): il tema vale finché la pagina resta aperta
  }
}

export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice);
  const update = useCallback((next: ThemeChoice) => {
    applyChoice(next);
    setChoice(next);
  }, []);
  return [choice, update];
}

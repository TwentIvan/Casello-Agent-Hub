import type { EmbedTab } from "@/embed/protocol";

// Schede del pannello unico. Le prime quattro sono le stesse ovunque, nello stesso ordine; la console aggiunge
// «Barbara» (chat con Barbara, la Responsabile di Botcave: agente `general` dell'App `casello`), che le app ospiti non hanno,
// e l'embed «Segnalazioni» (segnalazioni dei bug dell'App ospite), che la console non ha.
export type PanelTab = EmbedTab | "lead";

export const TAB_LABELS: Record<PanelTab, string> = {
  alfred: "Alfred",
  pending: "Da confermare",
  bulletin: "Bollettino",
  lucius: "Lucius",
  bugs: "Segnalazioni",
  lead: "Barbara",
};

const COMMON_TABS: readonly PanelTab[] = ["alfred", "pending", "bulletin", "lucius"];
const EMBED_TABS: readonly PanelTab[] = [...COMMON_TABS, "bugs"];
const CONSOLE_TABS: readonly PanelTab[] = [...COMMON_TABS, "lead"];

/** Schede del pannello per la superficie. */
export function tabOrder(surface: "console" | "embed"): readonly PanelTab[] {
  return surface === "console" ? CONSOLE_TABS : EMBED_TABS;
}

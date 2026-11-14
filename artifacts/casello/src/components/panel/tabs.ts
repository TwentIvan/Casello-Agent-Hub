import type { EmbedTab } from "@/embed/protocol";

// Schede del pannello unico. Le quattro dell'embed sono le stesse ovunque, nello stesso ordine; la console aggiunge
// «Barbara» (chat con Barbara, la Responsabile di Botcave: agente `general` dell'App `casello`), che le app ospiti non hanno.
export type PanelTab = EmbedTab | "lead";

export const TAB_LABELS: Record<PanelTab, string> = {
  alfred: "Alfred",
  pending: "Da confermare",
  bulletin: "Bollettino",
  lucius: "Lucius",
  lead: "Barbara",
};

const EMBED_TABS: readonly PanelTab[] = ["alfred", "pending", "bulletin", "lucius"];
const CONSOLE_TABS: readonly PanelTab[] = [...EMBED_TABS, "lead"];

/** Schede del pannello per la superficie. */
export function tabOrder(surface: "console" | "embed"): readonly PanelTab[] {
  return surface === "console" ? CONSOLE_TABS : EMBED_TABS;
}

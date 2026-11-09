import type { EmbedTab } from "@/embed/protocol";

// Le quattro schede del pannello unico (console e app ospiti), nello stesso ordine ovunque.
export type PanelTab = EmbedTab;

export const TAB_LABELS: Record<PanelTab, string> = {
  alfred: "Alfred",
  pending: "Da confermare",
  bulletin: "Bollettino",
  lucius: "Lucius",
};

export const TAB_ORDER: readonly PanelTab[] = ["alfred", "pending", "bulletin", "lucius"];

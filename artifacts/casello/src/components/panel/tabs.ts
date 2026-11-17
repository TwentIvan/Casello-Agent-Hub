import type { BotNames } from "@workspace/api-client-react";
import type { EmbedTab } from "@/embed/protocol";

// Schede del pannello unico. Nell'embed prima i tre bot (Alfred, Lucius, il Responsabile dell'App ospite), poi coda,
// bollettino e segnalazioni dei bug dell'App ospite; la console ha le sue cinque schede, nell'ordine di sempre, con
// «Barbara» (la Responsabile di Botcave: agente `general` dell'App `casello`) e senza segnalazioni.
// Le schede sono elencate anche in `EmbedTab` e in `TABS` di `embed/protocol.ts`: vanno tenute allineate.
export type PanelTab = EmbedTab;

export type BotTab = "alfred" | "lucius" | "lead";

export const TAB_LABELS: Record<PanelTab, string> = {
  alfred: "Alfred",
  lucius: "Lucius",
  lead: "Responsabile",
  pending: "Da confermare",
  bulletin: "Bollettino",
  bugs: "Segnalazioni",
};

/** Nomi dei bot nella console: la Responsabile di Botcave è Barbara. */
export const CONSOLE_BOT_NAMES: BotNames = { alfred: "Alfred", lucius: "Lucius", lead: "Barbara" };

const EMBED_TABS: readonly PanelTab[] = ["alfred", "lucius", "lead", "pending", "bulletin", "bugs"];
const CONSOLE_TABS: readonly PanelTab[] = ["alfred", "pending", "bulletin", "lucius", "lead"];

/** Schede del pannello per la superficie. */
export function tabOrder(surface: "console" | "embed"): readonly PanelTab[] {
  return surface === "console" ? CONSOLE_TABS : EMBED_TABS;
}

export function isBotTab(tab: PanelTab): tab is BotTab {
  return tab === "alfred" || tab === "lucius" || tab === "lead";
}

/** Etichetta della scheda: i bot con i nomi dell'App (se noti), le altre fisse. */
export function tabLabel(tab: PanelTab, names: BotNames | null): string {
  if (names && isBotTab(tab)) return names[tab];
  return TAB_LABELS[tab];
}

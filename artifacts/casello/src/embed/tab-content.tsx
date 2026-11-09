// Contenuto delle quattro schede del pannello incorporato. Temporaneo: le schede stanno in components/panel/tabs/ e
// leggono tutto da usePanel(); il PanelProvider lo monta il Task 4, che elimina questo file.
import type { AlfredVoice } from "@/components/alfred/use-alfred-voice";
import { AlfredTab } from "@/components/panel/tabs/alfred-tab";
import { BulletinTab } from "@/components/panel/tabs/bulletin-tab";
import { LuciusTab } from "@/components/panel/tabs/lucius-tab";
import { PendingTab } from "@/components/panel/tabs/pending-tab";
import type { EmbedTab, HostContextMsg } from "./protocol";

export { TAB_LABELS, TAB_ORDER } from "@/components/panel/tabs";

export type TabContentProps = {
  tab: EmbedTab;
  /** Slug dell'App di Botcave indicato dalla pagina ospite (`data-app`). */
  appSlug: string;
  /** Nome dell'app ospite secondo la configurazione (`GET /api/embed/config`). */
  appName: string | null;
  /** Contesto della pagina ospite (`Botcave.setContext`). */
  hostContext: HostContextMsg | null;
  /** Voce di Alfred, tenuta dalla Shell: resta attiva cambiando scheda. */
  voice: AlfredVoice;
};

export function TabContent({ tab }: TabContentProps) {
  switch (tab) {
    case "alfred":
      return <AlfredTab />;
    case "pending":
      return <PendingTab />;
    case "bulletin":
      return <BulletinTab />;
    case "lucius":
      return <LuciusTab />;
  }
}

// Contenuto delle quattro schede del pannello incorporato: Alfred, Da confermare, Bollettino, Lucius (in tabs/).
import type { EmbedTab, HostContextMsg } from "./protocol";
import { AlfredTab } from "./tabs/alfred-tab";
import { BulletinTab } from "./tabs/bulletin-tab";
import { LuciusTab } from "./tabs/lucius-tab";
import { PendingTab } from "./tabs/pending-tab";

export const TAB_LABELS: Record<EmbedTab, string> = {
  alfred: "Alfred",
  pending: "Da confermare",
  bulletin: "Bollettino",
  lucius: "Lucius",
};

export const TAB_ORDER: readonly EmbedTab[] = ["alfred", "pending", "bulletin", "lucius"];

export type TabContentProps = {
  tab: EmbedTab;
  /** Slug dell'App di Botcave indicato dalla pagina ospite (`data-app`). */
  appSlug: string;
  /** Nome dell'app ospite secondo la configurazione (`GET /api/embed/config`). */
  appName: string | null;
  /** Contesto della pagina ospite (`Botcave.setContext`). */
  hostContext: HostContextMsg | null;
};

export function TabContent({ tab, appSlug, appName, hostContext }: TabContentProps) {
  switch (tab) {
    case "alfred":
      return <AlfredTab appSlug={appSlug} hostContext={hostContext} />;
    case "pending":
      return <PendingTab />;
    case "bulletin":
      return <BulletinTab />;
    case "lucius":
      return <LuciusTab appSlug={appSlug} appName={appName} />;
  }
}

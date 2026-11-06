// Contenuto delle quattro schede del pannello incorporato. Punto di aggancio unico per il Task 9
// (Alfred, Da confermare, Bollettino, Lucius): qui per ora un segnaposto.
import type { EmbedTab, HostContextMsg } from "./protocol";

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

export function TabContent({ tab }: TabContentProps) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <p className="text-body-sm text-ink-muted">{TAB_LABELS[tab]}</p>
    </div>
  );
}

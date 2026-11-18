// Corpo del pannello unico: intestazione con le schede della superficie e «Chiudi», sotto la scheda attiva.
// Lo stesso nella console (dentro lo Sheet) e nell'iframe delle app ospiti (a piena altezza). Nell'iframe l'intestazione
// ha logo e «Chiudi» su una riga, sotto le schede con icone, contatori e LED, sotto ancora la barra «Stai guardando».
import type { ReactNode } from "react";
import { BotcaveMark } from "@/components/brand/marks";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePanel } from "./panel-context";
import { TabStrip } from "./tab-strip";
import { CONSOLE_BOT_NAMES, tabLabel, tabOrder, type PanelTab } from "./tabs";
import { AlfredTab } from "./tabs/alfred-tab";
import { BugsTab } from "./tabs/bugs-tab";
import { BulletinTab } from "./tabs/bulletin-tab";
import { LeadTab } from "./tabs/lead-tab";
import { LuciusTab } from "./tabs/lucius-tab";
import { PendingTab } from "./tabs/pending-tab";

function ActiveTab({ tab }: { tab: PanelTab }) {
  switch (tab) {
    case "alfred":
      return <AlfredTab />;
    case "pending":
      return <PendingTab />;
    case "bulletin":
      return <BulletinTab />;
    case "lucius":
      return <LuciusTab />;
    case "lead":
      return <LeadTab />;
    case "bugs":
      return <BugsTab />;
  }
}

/** Contatori e LED delle schede e la barra del contesto: solo nell'iframe delle app ospiti. */
export interface EmbedPanelChrome {
  counts: Partial<Record<PanelTab, number>>;
  working: Partial<Record<PanelTab, boolean>>;
  contextBar: ReactNode;
}

export function BotcavePanel({ chrome }: { chrome?: EmbedPanelChrome }) {
  const { state, env, selectTab, closePanel } = usePanel();
  if (env.surface === "embed") {
    const tabs = tabOrder("embed");
    const labels = Object.fromEntries(tabs.map((t) => [t, tabLabel(t, env.botNames)])) as Record<PanelTab, string>;
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface-1 text-ink">
        <header className="min-w-0 border-b border-border px-3 pb-1 pt-2">
          <div className="flex items-center gap-2">
            <BotcaveMark className="h-5" />
            <span className="min-w-0 flex-1 truncate text-label text-ink-muted">Botcave</span>
            <Button variant="ghost" size="sm" onClick={closePanel}>
              Chiudi
            </Button>
          </div>
          <div className="mt-1 flex min-w-0">
            <TabStrip
              tabs={tabs}
              active={state.tab}
              labels={labels}
              counts={chrome?.counts ?? {}}
              working={chrome?.working ?? {}}
              onSelect={selectTab}
            />
          </div>
        </header>
        {chrome?.contextBar}
        <div role="tabpanel" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
          <ActiveTab tab={state.tab} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1 text-ink">
      <header className="flex items-start gap-2 border-b border-border px-3 py-2">
        <BotcaveMark className="h-5" />
        <nav role="tablist" aria-label="Schede di Botcave" className="flex min-w-0 flex-1 flex-wrap gap-1">
          {tabOrder(env.surface).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={state.tab === t}
              onClick={() => selectTab(t)}
              className={cn(
                "whitespace-nowrap rounded-sm px-2 py-1 text-label",
                state.tab === t ? "bg-surface-2 text-ink" : "text-ink-muted hover:text-ink",
              )}
            >
              {tabLabel(t, CONSOLE_BOT_NAMES)}
            </button>
          ))}
        </nav>
        <Button variant="ghost" size="sm" onClick={closePanel}>
          Chiudi
        </Button>
      </header>
      <div role="tabpanel" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
        <ActiveTab tab={state.tab} />
      </div>
    </div>
  );
}

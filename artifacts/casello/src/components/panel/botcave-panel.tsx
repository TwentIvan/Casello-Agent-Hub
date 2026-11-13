// Corpo del pannello unico: intestazione con le quattro schede e «Chiudi», sotto la scheda attiva.
// Lo stesso nella console (dentro lo Sheet) e nell'iframe delle app ospiti (a piena altezza).
import { BotcaveMark } from "@/components/brand/marks";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePanel } from "./panel-context";
import { TAB_LABELS, tabOrder, type PanelTab } from "./tabs";
import { AlfredTab } from "./tabs/alfred-tab";
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
  }
}

export function BotcavePanel() {
  const { state, env, selectTab, closePanel } = usePanel();
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
              {TAB_LABELS[t]}
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

// Riga delle schede del pannello incorporato: icona sopra ed etichetta sotto, su una riga sola; sotto i 360 px di
// larghezza restano le sole icone (query di contenitore), con l'etichetta in `aria-label` e `title`.
// Contatori sulle schede che li hanno, LED `work` sul bot che sta rispondendo.
import { Bug, Newspaper, ShieldCheck, type LucideIcon } from "lucide-react";
import { LedDot } from "@/components/brand/led";
import { AlfredMark, BarbaraMark, LuciusMark } from "@/components/brand/marks";
import { cn } from "@/lib/utils";
import type { PanelTab } from "./tabs";

// Icone della console: «Da confermare» come nel menu; bollettino e segnalazioni dalla stessa raccolta
const ICONS: Partial<Record<PanelTab, LucideIcon>> = { pending: ShieldCheck, bulletin: Newspaper, bugs: Bug };

function TabIcon({ tab }: { tab: PanelTab }) {
  switch (tab) {
    case "alfred":
      return <AlfredMark size={18} />;
    case "lucius":
      return <LuciusMark size={18} />;
    case "lead":
      return <BarbaraMark size={18} />;
    default: {
      const Icon = ICONS[tab];
      return Icon ? <Icon className="size-4" aria-hidden="true" /> : null;
    }
  }
}

export function TabStrip({
  tabs,
  active,
  labels,
  counts,
  working,
  onSelect,
}: {
  tabs: readonly PanelTab[];
  active: PanelTab;
  labels: Record<PanelTab, string>;
  counts: Partial<Record<PanelTab, number>>;
  working: Partial<Record<PanelTab, boolean>>;
  onSelect(tab: PanelTab): void;
}) {
  return (
    <div className="@container min-w-0 flex-1">
      <nav role="tablist" aria-label="Schede di Botcave" className="flex min-w-0">
        {tabs.map((t) => {
          const count = counts[t] ?? 0;
          const busy = working[t] === true;
          const label = labels[t];
          const extra = [count > 0 ? String(count) : null, busy ? "sta rispondendo" : null].filter(Boolean).join(", ");
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={active === t}
              aria-label={extra ? `${label} (${extra})` : label}
              title={label}
              onClick={() => onSelect(t)}
              className={cn(
                "relative flex min-w-0 flex-1 flex-col items-center gap-1 rounded-sm px-1 py-1.5",
                active === t ? "bg-surface-2 text-ink" : "text-ink-muted hover:text-ink",
              )}
            >
              <span className="relative flex h-5 items-center justify-center">
                <TabIcon tab={t} />
                {busy && <LedDot state="work" className="absolute -bottom-0.5 -right-2.5" />}
                {count > 0 && (
                  <span className="absolute -right-4 -top-1.5 min-w-4 rounded-none bg-brand px-1 text-center font-mono text-[10px] leading-4 text-on-brand">
                    {count}
                  </span>
                )}
              </span>
              {/* Due righe al più, con la sillabazione italiana: «Da confermare» e «Segnalazioni» stanno nella colonna */}
              <span aria-hidden="true" className="line-clamp-2 w-full hyphens-auto break-words text-center text-label leading-tight @max-[360px]:hidden">
                {label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

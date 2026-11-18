// Barra «Stai guardando» del pannello incorporato: la pagina dell'app ospite (titolo, o tipo e id) e le azioni configurate
// per quel tipo di pagina. Visibile in tutte le schede; ridotta è una riga con il titolo e il numero di azioni.
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HostContextMsg } from "@/embed/protocol";

/** Cosa si mostra della pagina: il titolo, altrimenti tipo e id. */
export function contextTitle(context: HostContextMsg): string {
  if (context.title) return context.title;
  return context.id ? `${context.page} · ${context.id}` : context.page;
}

export function actionsCountLabel(n: number): string {
  return n === 1 ? "1 azione" : `${n} azioni`;
}

export function ContextBar({
  context,
  actions,
  onAction,
  collapsed,
  onToggle,
}: {
  context: HostContextMsg;
  actions: readonly { label: string }[];
  onAction(label: string): void;
  collapsed: boolean;
  onToggle(): void;
}) {
  const title = contextTitle(context);
  const hasActions = actions.length > 0;
  return (
    <section aria-label="Stai guardando" className="min-w-0 border-b border-border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-label text-ink-muted">Stai guardando</span>
        <span className="min-w-0 flex-1 truncate text-body-sm text-ink" title={title}>
          {title}
        </span>
        {collapsed && hasActions && <span className="shrink-0 font-mono text-label text-ink-muted">{actionsCountLabel(actions.length)}</span>}
        {hasActions && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-1"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Mostra le azioni" : "Riduci la barra"}
            title={collapsed ? "Mostra le azioni" : "Riduci la barra"}
          >
            {collapsed ? <ChevronDown /> : <ChevronUp />}
          </Button>
        )}
      </div>
      {!collapsed && hasActions && (
        <div className="mt-2 flex min-w-0 flex-wrap gap-2">
          {actions.map((a) => (
            <Button key={a.label} variant="secondary" size="sm" className="max-w-full" onClick={() => onAction(a.label)}>
              <span className="truncate">{a.label}</span>
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

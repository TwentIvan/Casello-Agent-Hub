// Sotto una risposta del Responsabile: le voci messe in coda dalla sua run e il collegamento alla run.
import type { LeadQueueItem } from "@workspace/api-client-react";
import { LedDot, type LedState } from "@/components/brand/led";
import { usePanel } from "@/components/panel/panel-context";
import { PanelLink } from "@/components/panel/panel-link";
import type { LeadRunPayload } from "./lead-detail";

function itemLed(status: string): LedState {
  if (status === "pending") return "ask";
  if (status === "done") return "ok";
  if (status === "failed") return "ko";
  return "idle";
}

function ItemRow({ item, onOpen }: { item: LeadQueueItem; onOpen(): void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full min-w-0 items-center gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-surface-2">
        <LedDot state={itemLed(item.status)} className="shrink-0" />
        <span className="shrink-0 font-mono text-xs tabular-nums text-ink-muted">#{item.number}</span>
        <span className="min-w-0 truncate text-sm">{item.summary}</span>
      </button>
    </li>
  );
}

export function LeadRunCard({ payload }: { payload: LeadRunPayload }) {
  const { selectTab } = usePanel();
  return (
    <div className="min-w-0 space-y-1 rounded-md border border-border p-2">
      {payload.items.length > 0 && (
        <>
          <p className="text-label text-ink-muted">In Da confermare</p>
          <ul className="space-y-0.5">
            {payload.items.map((item) => (
              <ItemRow key={item.number} item={item} onOpen={() => selectTab("pending")} />
            ))}
          </ul>
        </>
      )}
      <PanelLink path={`/runs/${payload.runId}`} className="inline-block text-sm text-accent-text underline-offset-2 hover:underline">
        Apri la run #{payload.runId}
      </PanelLink>
    </div>
  );
}

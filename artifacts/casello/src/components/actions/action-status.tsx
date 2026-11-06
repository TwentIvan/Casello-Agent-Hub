import type { QueuedActionStatus } from "@workspace/api-client-react";
import { Led, type LedState } from "@/components/brand/led";

export const ACTION_STATUS_LABELS: Record<QueuedActionStatus, string> = {
  pending: "In attesa",
  executing: "In esecuzione",
  done: "Eseguita",
  failed: "Fallita",
  rejected: "Rifiutata",
};

// In attesa = serve una decisione (LED che lampeggia); in esecuzione = al lavoro
const LED: Record<QueuedActionStatus, LedState> = {
  pending: "ask",
  executing: "work",
  done: "ok",
  failed: "ko",
  rejected: "idle",
};

export function ActionStatusBadge({ status, className }: { status: QueuedActionStatus; className?: string }) {
  return (
    <Led state={LED[status]} label={ACTION_STATUS_LABELS[status]} className={className} />
  );
}

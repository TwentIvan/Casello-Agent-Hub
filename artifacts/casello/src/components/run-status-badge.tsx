import type { RunStatus } from "@workspace/api-client-react";
import { Led, type LedState } from "@/components/brand/led";

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  pending: "In attesa",
  running: "In corso",
  succeeded: "Riuscita",
  failed: "Fallita",
  // Stato storico: le run non si fermano più in attesa (le azioni L2 vanno in coda)
  awaiting_client: "In attesa (storico)",
  cancelled: "Annullata",
};

const LED: Record<RunStatus, LedState> = {
  pending: "idle",
  running: "work",
  succeeded: "ok",
  failed: "ko",
  awaiting_client: "idle",
  cancelled: "idle",
};

export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <Led state={LED[status]} label={RUN_STATUS_LABELS[status]} className={className} />
  );
}

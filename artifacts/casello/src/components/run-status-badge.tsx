import type { RunStatus } from "@workspace/api-client-react";
import { Led, type LedState } from "@/components/brand/led";

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  pending: "In coda",
  running: "In corso",
  succeeded: "Riuscita",
  failed: "Fallita",
  // In attesa dell'esito di un tool ui dall'app che ha avviato la run
  awaiting_client: "In attesa del client",
  cancelled: "Annullata",
};

const LED: Record<RunStatus, LedState> = {
  pending: "idle",
  running: "work",
  succeeded: "ok",
  failed: "ko",
  awaiting_client: "ask",
  cancelled: "idle",
};

export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <Led state={LED[status]} label={RUN_STATUS_LABELS[status]} className={className} />
  );
}

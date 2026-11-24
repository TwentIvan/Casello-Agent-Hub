// Istruzioni a una run in corso (issue #119): funzioni pure della carta «Istruzioni» nella pagina della run.
import type { RunMessage, RunStatus } from "@workspace/api-client-react";
import type { LedState } from "@/components/brand/led";

/** Lunghezza massima di un'istruzione (uguale al server). */
export const RUN_MESSAGE_MAX_CHARS = 2_000;

const VIEW: Record<RunMessage["status"], { led: LedState; label: string }> = {
  pending: { led: "work", label: "In attesa del prossimo passo" },
  delivered: { led: "ok", label: "Consegnata" },
  dropped: { led: "idle", label: "Non consegnata: la run è finita prima" },
};

export function runMessageView(status: RunMessage["status"]): { led: LedState; label: string } {
  return VIEW[status];
}

/** Si possono mandare istruzioni solo alla run in esecuzione. */
export function canInstruct(status: RunStatus): boolean {
  return status === "running";
}

/** Motivo per cui «Manda l'istruzione» è disattivato, null se si può mandare. */
export function instructionError(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "Scrivi l'istruzione";
  if (trimmed.length > RUN_MESSAGE_MAX_CHARS) return `Al massimo ${RUN_MESSAGE_MAX_CHARS} caratteri`;
  return null;
}
